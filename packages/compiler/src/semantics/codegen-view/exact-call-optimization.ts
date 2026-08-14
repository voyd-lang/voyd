import { incrementCompilerPerfCounter } from "../../perf.js";
import { walkExpression, type HirFunction } from "../hir/index.js";
import type { HirExprId, ProgramFunctionId, SymbolId, TypeId } from "../ids.js";
import type {
  ExactCallOptimizationDecision,
  ExactCallOptimizationFact,
  ExactCallOptimizationFallbackReason,
  ExactCallOptimizationIndex,
  ExactCallOptimizationMetrics,
  ExactCallOptimizationParameterFact,
  ProgramCodegenView,
} from "./index.js";

export const EXACT_CALL_OPTIMIZATION_WORK_BUDGET = 4_096;
export const EXACT_CALL_OPTIMIZATION_FACT_BUDGET_BYTES = 64 * 1_024;
export const EXACT_CALL_OPTIMIZATION_CACHE_BUDGET_BYTES = 1_024 * 1_024;
const CACHED_FALLBACK_BYTES = 32;

const SAFE_PRIMITIVE_CALLS = new Set([
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  "<=",
  ">",
  ">=",
  "==",
  "!=",
  "and",
  "or",
  "xor",
  "not",
]);

type MutableParameterFact = {
  readFields: Set<string>;
  writeFields: Set<string>;
  readsWholeValue: boolean;
  writesWholeValue: boolean;
  indirectAccess: boolean;
  escapes: boolean;
  retained: boolean;
  resultAliases: boolean;
};

type ScanResult = {
  decision: ExactCallOptimizationDecision;
  workUnits: number;
};

export const createExactCallOptimizationIndex = (
  getProgram: () => ProgramCodegenView,
): ExactCallOptimizationIndex => {
  const cache = new Map<ProgramFunctionId, ExactCallOptimizationDecision>();
  let retainedBytes = 0;
  const metrics: ExactCallOptimizationMetrics = {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    bodyVisits: 0,
    acceptedFacts: 0,
    fallbacks: 0,
    budgetExhaustions: 0,
    workUnits: 0,
    retainedBytes: 0,
  };

  const recordDecision = (
    target: ProgramFunctionId,
    result: ScanResult,
  ): ExactCallOptimizationDecision => {
    metrics.workUnits += result.workUnits;
    incrementCompilerPerfCounter(
      "codegen.exact_call.work_units",
      result.workUnits,
    );
    incrementCompilerPerfCounter(
      "codegen.exact_call.analysis_operations",
      result.workUnits,
    );

    let decision = result.decision;
    let decisionBytes = CACHED_FALLBACK_BYTES;
    if (decision.kind === "available") {
      const factBytes = estimateFactBytes(decision.fact);
      if (
        factBytes > EXACT_CALL_OPTIMIZATION_FACT_BUDGET_BYTES ||
        retainedBytes + factBytes > EXACT_CALL_OPTIMIZATION_CACHE_BUDGET_BYTES
      ) {
        decision = { kind: "fallback", reason: "memory-budget" };
        metrics.budgetExhaustions += 1;
        incrementCompilerPerfCounter(
          factBytes > EXACT_CALL_OPTIMIZATION_FACT_BUDGET_BYTES
            ? "codegen.exact_call.budget_exhaustion.per_body_memory"
            : "codegen.exact_call.budget_exhaustion.compile_wide_memory",
        );
      } else {
        decisionBytes = factBytes;
        metrics.acceptedFacts += 1;
        incrementCompilerPerfCounter("codegen.exact_call.accepted");
      }
    }

    if (decision.kind === "fallback") {
      metrics.fallbacks += 1;
      incrementCompilerPerfCounter("codegen.exact_call.fallback");
      incrementCompilerPerfCounter(
        `codegen.exact_call.fallback.${decision.reason}`,
      );
      incrementCompilerPerfCounter(
        `codegen.exact_call.bailout.${decision.reason}`,
      );
      if (decision.reason === "work-budget") {
        metrics.budgetExhaustions += 1;
        incrementCompilerPerfCounter(
          "codegen.exact_call.budget_exhaustion.per_body_work",
        );
      }
    }
    if (
      retainedBytes + decisionBytes <=
      EXACT_CALL_OPTIMIZATION_CACHE_BUDGET_BYTES
    ) {
      cache.set(target, decision);
      retainedBytes += decisionBytes;
      metrics.retainedBytes = retainedBytes;
      incrementCompilerPerfCounter(
        "codegen.exact_call.retained_bytes",
        decisionBytes,
      );
    }
    return decision;
  };

  return {
    getFact: (target) => {
      metrics.requests += 1;
      incrementCompilerPerfCounter("codegen.exact_call.requests");
      const cached = cache.get(target);
      if (cached) {
        metrics.cacheHits += 1;
        incrementCompilerPerfCounter("codegen.exact_call.cache_hits");
        return cached;
      }
      metrics.cacheMisses += 1;
      metrics.bodyVisits += 1;
      incrementCompilerPerfCounter("codegen.exact_call.cache_misses");
      incrementCompilerPerfCounter("codegen.exact_call.body_visits");
      return recordDecision(target, scanExactCallBody({ target, getProgram }));
    },
    getMetrics: () => ({ ...metrics }),
  };
};

const scanExactCallBody = ({
  target,
  getProgram,
}: {
  target: ProgramFunctionId;
  getProgram: () => ProgramCodegenView;
}): ScanResult => {
  const program = getProgram();
  const ref = program.functions.getFunctionRef(target);
  const moduleView = ref ? program.modules.get(ref.moduleId) : undefined;
  const item =
    ref && moduleView
      ? Array.from(moduleView.hir.items.values()).find(
          (candidate): candidate is HirFunction =>
            candidate.kind === "function" && candidate.symbol === ref.symbol,
        )
      : undefined;
  const signature = ref
    ? program.functions.getSignature(ref.moduleId, ref.symbol)
    : undefined;
  if (!ref || !moduleView || !item || !signature) {
    return fallback("missing-body", 0);
  }
  if (
    item.parameters.some(
      (parameter) =>
        parameter.pattern.kind !== "identifier" ||
        parameter.pattern.symbol !== parameter.symbol,
    )
  ) {
    return fallback("unsupported-alias", 0);
  }

  const parameterBySymbol = new Map<SymbolId, number>(
    item.parameters.map((parameter, index) => [parameter.symbol, index]),
  );
  const parameters: MutableParameterFact[] = item.parameters.map(() => ({
    readFields: new Set(),
    writeFields: new Set(),
    readsWholeValue: false,
    writesWholeValue: false,
    indirectAccess: false,
    escapes: false,
    retained: false,
    resultAliases: false,
  }));
  const resultExpressions = new Set<HirExprId>();
  const targetFlags = program.symbols.getIntrinsicFunctionFlags(target);
  const boundary = {
    explicitReturn: false,
    nestedCall: false,
    recursiveCall: false,
    dynamicCall: false,
    unresolvedCall: false,
    identityGuard: false,
    externalAccess: targetFlags.intrinsic || targetFlags.external !== undefined,
    maySuspend: !program.effects.isEmpty(signature.effectRow),
  };
  let workUnits = 0;
  let fallbackReason: ExactCallOptimizationFallbackReason | undefined;

  const useWork = (): boolean => {
    workUnits += 1;
    if (workUnits <= EXACT_CALL_OPTIMIZATION_WORK_BUDGET) {
      return true;
    }
    fallbackReason = "work-budget";
    return false;
  };
  const exprAt = (exprId: HirExprId) => moduleView.hir.expressions.get(exprId);
  const canonicalId = (symbol: SymbolId) =>
    program.symbols.canonicalIdOf(moduleView.moduleId, symbol);
  const callableName = (symbol: SymbolId): string | undefined => {
    const id = canonicalId(symbol);
    return program.symbols.getIntrinsicName(id) ?? program.symbols.getName(id);
  };
  const isBorrowMarker = (exprId: HirExprId): boolean => {
    const expr = exprAt(exprId);
    if (expr?.exprKind !== "call" || expr.args.length !== 1) {
      return false;
    }
    const callee = exprAt(expr.callee);
    if (callee?.exprKind !== "identifier") return false;
    const id = canonicalId(callee.symbol);
    return (
      callableName(callee.symbol) === "~" &&
      program.symbols.getIntrinsicFunctionFlags(id).intrinsic
    );
  };
  type ParameterPath = {
    parameter: number;
    firstField?: string;
    depth: number;
  };
  const parameterPaths = new Map<HirExprId, ParameterPath | null>();
  const parameterPathFor = (
    exprId: HirExprId,
    searchDepth = 0,
  ): ParameterPath | undefined => {
    if (searchDepth >= EXACT_CALL_OPTIMIZATION_WORK_BUDGET) {
      fallbackReason = "work-budget";
      return undefined;
    }
    const cached = parameterPaths.get(exprId);
    if (cached !== undefined) return cached ?? undefined;
    if (!useWork()) return undefined;
    const expr = exprAt(exprId);
    let path: ParameterPath | undefined;
    if (expr?.exprKind === "identifier") {
      const parameter = parameterBySymbol.get(expr.symbol);
      path =
        typeof parameter === "number" ? { parameter, depth: 0 } : undefined;
    } else if (expr?.exprKind === "field-access") {
      const targetPath = parameterPathFor(expr.target, searchDepth + 1);
      path = targetPath
        ? {
            parameter: targetPath.parameter,
            firstField: targetPath.firstField ?? expr.field,
            depth: targetPath.depth + 1,
          }
        : undefined;
    } else if (expr?.exprKind === "call" && isBorrowMarker(exprId)) {
      const argument = expr.args[0];
      path = argument
        ? parameterPathFor(argument.expr, searchDepth + 1)
        : undefined;
    }
    parameterPaths.set(exprId, path ?? null);
    return path;
  };
  const exprType = (exprId: HirExprId): TypeId =>
    moduleView.types.getResolvedExprType(exprId) ??
    moduleView.types.getExprType(exprId);
  const referenceBearingTypes = new Map<TypeId, boolean>();
  const typeCanCarryReference = (
    typeId: TypeId,
    active = new Set<TypeId>(),
  ): boolean => {
    const cached = referenceBearingTypes.get(typeId);
    if (cached !== undefined) return cached;
    if (!useWork()) return true;
    if (
      active.has(typeId) ||
      active.size >= EXACT_CALL_OPTIMIZATION_WORK_BUDGET ||
      referenceBearingTypes.size >= EXACT_CALL_OPTIMIZATION_WORK_BUDGET
    ) {
      return true;
    }
    active.add(typeId);
    const borrowed = program.types.getBorrowedInner(typeId);
    const desc = program.types.getTypeDesc(typeId);
    const result =
      typeof borrowed === "number"
        ? true
        : desc.kind === "primitive"
          ? !(
              typeId === program.primitives.bool ||
              typeId === program.primitives.i32 ||
              typeId === program.primitives.i64 ||
              typeId === program.primitives.f32 ||
              typeId === program.primitives.f64 ||
              typeId === program.primitives.void
            )
          : desc.kind === "recursive"
            ? typeCanCarryReference(desc.body, active)
            : desc.kind === "union"
              ? desc.members.some((member) =>
                  typeCanCarryReference(member, active),
                )
              : desc.kind === "intersection"
                ? [desc.nominal, desc.structural, ...(desc.traits ?? [])].some(
                    (member) =>
                      typeof member === "number" &&
                      typeCanCarryReference(member, active),
                  )
                : true;
    active.delete(typeId);
    referenceBearingTypes.set(typeId, result);
    return result;
  };
  const isSafePrimitiveType = (typeId: TypeId): boolean =>
    typeId === program.primitives.bool ||
    typeId === program.primitives.i32 ||
    typeId === program.primitives.i64 ||
    typeId === program.primitives.f32 ||
    typeId === program.primitives.f64 ||
    typeId === program.primitives.void;
  const isSafePrimitiveCall = (exprId: HirExprId): boolean => {
    const expr = exprAt(exprId);
    if (expr?.exprKind !== "call") return false;
    const callee = exprAt(expr.callee);
    if (callee?.exprKind !== "identifier") return false;
    const name = callableName(callee.symbol);
    const flags = program.symbols.getIntrinsicFunctionFlags(
      canonicalId(callee.symbol),
    );
    return (
      typeof name === "string" &&
      SAFE_PRIMITIVE_CALLS.has(name) &&
      flags.intrinsic &&
      flags.external === undefined &&
      isSafePrimitiveType(exprType(exprId)) &&
      expr.args.every((argument) =>
        isSafePrimitiveType(exprType(argument.expr)),
      )
    );
  };
  const markReferenceFlow = ({
    exprId,
    parameter,
    parentId,
    tailPosition,
    statement,
  }: {
    exprId: HirExprId;
    parameter: number;
    parentId?: HirExprId;
    tailPosition: boolean;
    statement?: { kind: string; value?: HirExprId; initializer?: HirExprId };
  }): void => {
    if (!typeCanCarryReference(exprType(exprId))) return;
    const fact = parameters[parameter]!;
    const parent = typeof parentId === "number" ? exprAt(parentId) : undefined;
    if (resultExpressions.has(exprId) || statement?.kind === "return") {
      fact.resultAliases = true;
    }
    if (parent?.exprKind === "tuple" || parent?.exprKind === "object-literal") {
      fact.escapes = true;
      fact.retained = true;
      return;
    }
    if (tailPosition && parent?.exprKind !== "field-access") {
      fact.resultAliases = true;
      return;
    }
    if (
      parent?.exprKind === "assign" &&
      parent.value === exprId &&
      parent.target !== exprId
    ) {
      fact.escapes = true;
      fact.retained = true;
      return;
    }
    if (parent?.exprKind === "call" || parent?.exprKind === "method-call") {
      fact.escapes = true;
      fact.retained = true;
    }
  };
  const classifyCall = (exprId: HirExprId): void => {
    const expr = exprAt(exprId);
    if (
      !expr ||
      (expr.exprKind !== "call" && expr.exprKind !== "method-call") ||
      (expr.exprKind === "call" &&
        (isBorrowMarker(exprId) || isSafePrimitiveCall(exprId)))
    ) {
      return;
    }
    boundary.nestedCall = true;
    const info = program.calls.getCallInfo(moduleView.moduleId, exprId);
    boundary.identityGuard ||= info.identityGuards.length > 0;
    boundary.dynamicCall ||= info.traitDispatch;
    const resolvedTargets = [...new Set(info.targets?.values() ?? [])];
    if (resolvedTargets.length === 0 && expr.exprKind === "call") {
      const callee = exprAt(expr.callee);
      const direct =
        callee?.exprKind === "identifier"
          ? program.functions.getFunctionId({
              moduleId: moduleView.moduleId,
              symbol: callee.symbol,
            })
          : undefined;
      if (typeof direct === "number") {
        resolvedTargets.push(direct);
      }
    }
    if (resolvedTargets.length === 0) {
      boundary.unresolvedCall = true;
      boundary.dynamicCall = true;
    }
    resolvedTargets.forEach((resolvedTarget) => {
      boundary.recursiveCall ||= resolvedTarget === target;
      boundary.externalAccess ||=
        program.symbols.getIntrinsicFunctionFlags(resolvedTarget).external !==
        undefined;
    });
    if (expr.exprKind === "call") {
      const callee = exprAt(expr.callee);
      if (callee?.exprKind === "identifier") {
        boundary.externalAccess ||=
          program.symbols.getIntrinsicFunctionFlags(canonicalId(callee.symbol))
            .external !== undefined;
      }
      boundary.maySuspend ||= expr.effectOperation !== undefined;
    }
  };
  const scanRoot = ({
    root,
    tracksResult,
  }: {
    root: HirExprId;
    tracksResult: boolean;
  }): void => {
    walkExpression({
      exprId: root,
      hir: moduleView.hir,
      options: { skipLambdas: true },
      onEnterStatement: (_statementId, statement) => {
        if (!useWork()) return { stop: true };
        if (statement.kind === "return") {
          boundary.explicitReturn = true;
        }
        if (statement.kind !== "let") return;
        const path = parameterPathFor(statement.initializer);
        if (
          path &&
          (path.depth === 0 ||
            typeCanCarryReference(exprType(statement.initializer)))
        ) {
          fallbackReason = "unsupported-alias";
          return { stop: true };
        }
      },
      onEnterExpression: (exprId, expr, context) => {
        if (!useWork()) return { stop: true };
        const parent =
          typeof context.parent === "number"
            ? exprAt(context.parent)
            : undefined;
        if (
          (tracksResult && context.tailPosition) ||
          (typeof context.parent === "number" &&
            resultExpressions.has(context.parent) &&
            (parent?.exprKind === "tuple" ||
              parent?.exprKind === "object-literal"))
        ) {
          resultExpressions.add(exprId);
        }
        if (expr.exprKind === "effect-handler") {
          boundary.maySuspend = true;
          boundary.externalAccess = true;
        }
        if (expr.exprKind === "lambda") {
          expr.captures.forEach((capture) => {
            const parameter = parameterBySymbol.get(capture.symbol);
            if (typeof parameter !== "number") return;
            parameters[parameter]!.escapes = true;
            parameters[parameter]!.retained = true;
            if (resultExpressions.has(exprId)) {
              parameters[parameter]!.resultAliases = true;
            }
          });
        }
        if (expr.exprKind === "call" || expr.exprKind === "method-call") {
          classifyCall(exprId);
        }
        if (expr.exprKind === "field-access") {
          const path = parameterPathFor(exprId);
          if (!path || path.depth === 0) return;
          if (parent?.exprKind === "field-access" && parent.target === exprId) {
            return;
          }
          const fact = parameters[path.parameter]!;
          if (path.depth !== 1 || !path.firstField) {
            fact.indirectAccess = true;
          } else if (
            parent?.exprKind === "assign" &&
            parent.target === exprId
          ) {
            fact.writeFields.add(path.firstField);
          } else {
            fact.readFields.add(path.firstField);
          }
          markReferenceFlow({
            exprId,
            parameter: path.parameter,
            parentId: context.parent,
            tailPosition: context.tailPosition,
            statement: context.statement,
          });
          return;
        }
        if (expr.exprKind !== "identifier") return;
        const parameter = parameterBySymbol.get(expr.symbol);
        if (typeof parameter === "number") {
          if (parent?.exprKind === "field-access" && parent.target === exprId) {
            return;
          }
          const fact = parameters[parameter]!;
          if (parent?.exprKind === "assign" && parent.target === exprId) {
            fact.writesWholeValue = true;
          } else {
            fact.readsWholeValue = true;
          }
          markReferenceFlow({
            exprId,
            parameter,
            parentId: context.parent,
            tailPosition: context.tailPosition,
            statement: context.statement,
          });
          return;
        }
        const id = canonicalId(expr.symbol);
        const isCallee =
          parent?.exprKind === "call" && parent.callee === exprId;
        if (program.symbols.isModuleScoped(id) && !isCallee) {
          boundary.externalAccess = true;
        }
      },
    });
  };

  item.parameters.forEach((parameter) => {
    if (typeof parameter.defaultValue === "number" && !fallbackReason) {
      scanRoot({ root: parameter.defaultValue, tracksResult: false });
    }
  });
  if (!fallbackReason) scanRoot({ root: item.body, tracksResult: true });
  if (fallbackReason) return fallback(fallbackReason, workUnits);

  const fact: ExactCallOptimizationFact = {
    parameters: parameters.map(freezeParameterFact),
    ...boundary,
  };
  return { decision: { kind: "available", fact }, workUnits };
};

const freezeParameterFact = (
  fact: MutableParameterFact,
): ExactCallOptimizationParameterFact => ({
  readFields: [...fact.readFields].sort(),
  writeFields: [...fact.writeFields].sort(),
  readsWholeValue: fact.readsWholeValue,
  writesWholeValue: fact.writesWholeValue,
  indirectAccess: fact.indirectAccess,
  escapes: fact.escapes,
  retained: fact.retained,
  resultAliases: fact.resultAliases,
});

const estimateFactBytes = (fact: ExactCallOptimizationFact): number =>
  96 +
  fact.parameters.reduce(
    (total, parameter) =>
      total +
      64 +
      [...parameter.readFields, ...parameter.writeFields].reduce(
        (fieldBytes, field) => fieldBytes + 16 + field.length * 2,
        0,
      ),
    0,
  );

const fallback = (
  reason: Extract<
    ExactCallOptimizationDecision,
    { kind: "fallback" }
  >["reason"],
  workUnits: number,
): ScanResult => ({
  decision: { kind: "fallback", reason },
  workUnits,
});
