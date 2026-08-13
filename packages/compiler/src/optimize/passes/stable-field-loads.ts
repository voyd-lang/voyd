import { walkExpression } from "../../semantics/hir/index.js";
import type { HirExpression, HirFunction } from "../../semantics/hir/index.js";
import type {
  HirExprId,
  ProgramFunctionId,
  ProgramFunctionInstanceId,
  SymbolId,
} from "../../semantics/ids.js";
import type {
  ExactCallOptimizationFact,
  ProgramCodegenView,
} from "../../semantics/codegen-view/index.js";
import type { ProgramOptimizationPass } from "../pass.js";
import type { OptimizedCallInfo, ReadonlyOptimizedModuleView } from "../ir.js";
import { exactNominalForType, exprTypeFor } from "./shared.js";
import type { StableFieldFallbackReason } from "../../perf-counter-schema.js";

type AliasGroups = {
  rootOf(symbol: SymbolId): SymbolId;
  aliases(left: SymbolId, right: SymbolId): boolean;
  isFresh(symbol: SymbolId): boolean;
};

type Candidate = {
  root: SymbolId;
  field: string;
  accessExprIds: HirExprId[];
};

type StableFieldCandidateDecision =
  | { accepted: true }
  | { accepted: false; reason: StableFieldFallbackReason };

export const stableFieldLoadForwardingPass: ProgramOptimizationPass = {
  name: "stable-field-load-forwarding",
  run(ctx) {
    const byModule = new Map<
      string,
      Map<HirExprId, readonly { accessExprIds: readonly HirExprId[] }[]>
    >();
    let forwardedLoads = 0;
    let candidatesConsidered = 0;
    let acceptedCandidates = 0;
    const fallbacks = new Map<StableFieldFallbackReason, number>();

    ctx.ir.modules.forEach((moduleView, moduleId) => {
      const loops = new Map<
        HirExprId,
        readonly { accessExprIds: readonly HirExprId[] }[]
      >();
      const calls = ctx.ir.calls.get(moduleId) ?? new Map();

      moduleView.hir.items.forEach((item) => {
        if (item.kind !== "function") {
          return;
        }
        const aliases = collectAliases(item, moduleView);
        walkExpression({
          exprId: item.body,
          hir: moduleView.hir,
          onEnterExpression: (exprId, expr) => {
            if (expr.exprKind !== "while") {
              return;
            }
            const rawCandidates = collectCandidates({
              body: expr.body,
              aliases,
              moduleView,
              program: ctx.ir.baseProgram,
            });
            const candidates = rawCandidates.flatMap((candidate) => {
              if (candidate.accessExprIds.length <= 1) {
                return [];
              }
              candidatesConsidered += 1;
              const decision = loopPreservesCandidate({
                body: expr.body,
                condition: expr.condition,
                functionBody: item.body,
                candidate,
                aliases,
                calls,
                moduleView,
                program: ctx.ir.baseProgram,
              });
              if (!decision.accepted) {
                fallbacks.set(
                  decision.reason,
                  (fallbacks.get(decision.reason) ?? 0) + 1,
                );
                return [];
              }
              acceptedCandidates += 1;
              return [candidate];
            });
            if (candidates.length === 0) {
              return;
            }
            loops.set(
              exprId,
              candidates.map(({ accessExprIds }) => ({ accessExprIds })),
            );
            forwardedLoads += candidates.reduce(
              (total, candidate) => total + candidate.accessExprIds.length - 1,
              0,
            );
          },
        });
      });

      if (loops.size > 0) {
        byModule.set(moduleId, loops);
      }
    });

    ctx.mutateProducedFacts((mutation) =>
      mutation.setFact("stableFieldLoadForwarding", byModule),
    );
    return {
      changed: forwardedLoads > 0,
      metrics: {
        forwarded_loads: forwardedLoads,
        candidates: candidatesConsidered,
        accepted: acceptedCandidates,
        ...Object.fromEntries(
          [...fallbacks].map(([reason, count]) => [
            `fallback.${reason}`,
            count,
          ]),
        ),
      },
    };
  },
};

const collectAliases = (
  fn: HirFunction,
  moduleView: ReadonlyOptimizedModuleView,
): AliasGroups => {
  const parents = new Map<SymbolId, SymbolId>();
  const freshSymbols = new Set<SymbolId>();
  const assignedSymbols = new Set<SymbolId>();
  const rootOf = (symbol: SymbolId): SymbolId => {
    const parent = parents.get(symbol);
    if (typeof parent !== "number" || parent === symbol) {
      return symbol;
    }
    const root = rootOf(parent);
    parents.set(symbol, root);
    return root;
  };
  const union = (left: SymbolId, right: SymbolId): void => {
    const leftRoot = rootOf(left);
    const rightRoot = rootOf(right);
    if (leftRoot !== rightRoot) {
      parents.set(rightRoot, leftRoot);
    }
  };

  walkExpression({
    exprId: fn.body,
    hir: moduleView.hir,
    onEnterStatement: (_stmtId, statement) => {
      if (statement.kind !== "let" || statement.pattern.kind !== "identifier") {
        return;
      }
      const initializer = moduleView.hir.expressions.get(statement.initializer);
      if (initializer?.exprKind === "identifier") {
        union(statement.pattern.symbol, initializer.symbol);
      } else if (initializer?.exprKind === "object-literal") {
        freshSymbols.add(statement.pattern.symbol);
      }
    },
    onEnterExpression: (_exprId, expression) => {
      if (
        expression.exprKind !== "assign" ||
        typeof expression.target !== "number"
      ) {
        return;
      }
      const target = moduleView.hir.expressions.get(expression.target);
      if (target?.exprKind === "identifier") {
        assignedSymbols.add(target.symbol);
      }
    },
  });
  return {
    rootOf,
    aliases: (left, right) => rootOf(left) === rootOf(right),
    isFresh: (symbol) =>
      [...freshSymbols].some((fresh) => rootOf(fresh) === rootOf(symbol)) &&
      ![...assignedSymbols].some(
        (assigned) => rootOf(assigned) === rootOf(symbol),
      ),
  };
};

const collectCandidates = ({
  body,
  aliases,
  moduleView,
  program,
}: {
  body: HirExprId;
  aliases: AliasGroups;
  moduleView: ReadonlyOptimizedModuleView;
  program: ProgramCodegenView;
}): Candidate[] => {
  const candidates = new Map<string, Candidate>();
  walkExpression({
    exprId: body,
    hir: moduleView.hir,
    onEnterExpression: (exprId, expr) => {
      if (expr.exprKind !== "field-access") {
        return;
      }
      const target = moduleView.hir.expressions.get(expr.target);
      const targetType = exprTypeFor({ moduleView, exprId: expr.target });
      const nominal = exactNominalForType({ typeId: targetType, program });
      if (
        target?.exprKind !== "identifier" ||
        typeof nominal !== "number" ||
        program.types.getTypeDesc(nominal).kind !== "nominal-object"
      ) {
        return;
      }
      const root = aliases.rootOf(target.symbol);
      if (!aliases.isFresh(root)) {
        return;
      }
      const key = `${root}:${expr.field}`;
      const candidate = candidates.get(key) ?? {
        root,
        field: expr.field,
        accessExprIds: [],
      };
      candidate.accessExprIds.push(exprId);
      candidates.set(key, candidate);
    },
  });
  return [...candidates.values()];
};

const loopPreservesCandidate = ({
  body,
  condition,
  functionBody,
  candidate,
  aliases,
  calls,
  moduleView,
  program,
}: {
  body: HirExprId;
  condition: HirExprId;
  functionBody: HirExprId;
  candidate: Candidate;
  aliases: AliasGroups;
  calls: ReadonlyMap<HirExprId, OptimizedCallInfo>;
  moduleView: ReadonlyOptimizedModuleView;
  program: ProgramCodegenView;
}): StableFieldCandidateDecision => {
  let fallback: StableFieldFallbackReason | undefined;
  const reject = (reason: StableFieldFallbackReason): void => {
    fallback ??= reason;
  };
  const inspectLoopExpression = (root: HirExprId): void =>
    walkExpression({
      exprId: root,
      hir: moduleView.hir,
      onEnterExpression: (exprId, expr) => {
        if (fallback) {
          return { stop: true };
        }
        if (expr.exprKind === "assign") {
          const valueSymbol = argumentRootSymbol({
            exprId: expr.value,
            moduleView,
            program,
          });
          if (
            !assignmentIsDisjoint({ expr, candidate, aliases, moduleView }) ||
            (typeof valueSymbol === "number" &&
              aliases.aliases(valueSymbol, candidate.root))
          ) {
            reject("local-mutation");
          }
          return;
        }
        if (expr.exprKind === "method-call") {
          const decision = callIsDisjoint({
            exprId,
            expr,
            candidate,
            aliases,
            callInfo: calls.get(exprId),
            moduleView,
            program,
          });
          if (!decision.accepted) reject(decision.reason);
          return;
        }
        if (
          expr.exprKind === "lambda" &&
          expr.captures?.some((capture) =>
            aliases.aliases(capture.symbol, candidate.root),
          )
        ) {
          reject("local-capture");
          return;
        }
        if (
          expr.exprKind === "object-literal" &&
          expr.entries.some((entry) => {
            const symbol = argumentRootSymbol({
              exprId: entry.value,
              moduleView,
              program,
            });
            return (
              typeof symbol === "number" &&
              aliases.aliases(symbol, candidate.root)
            );
          })
        ) {
          reject("local-retention");
          return;
        }
        if (
          expr.exprKind === "tuple" &&
          expr.elements.some((element) => {
            const symbol = argumentRootSymbol({
              exprId: element,
              moduleView,
              program,
            });
            return (
              typeof symbol === "number" &&
              aliases.aliases(symbol, candidate.root)
            );
          })
        ) {
          reject("local-retention");
          return;
        }
        if (expr.exprKind === "call") {
          const decision = callIsDisjoint({
            exprId,
            expr,
            candidate,
            aliases,
            callInfo: calls.get(exprId),
            moduleView,
            program,
          });
          if (!decision.accepted) reject(decision.reason);
        }
      },
    });
  inspectLoopExpression(condition);
  if (!fallback) {
    inspectLoopExpression(body);
  }
  if (fallback) {
    return { accepted: false, reason: fallback };
  }

  // A prior call that retains or returns an alias can make a later otherwise
  // unrelated call mutate it. Exclude such roots across the whole callable.
  walkExpression({
    exprId: functionBody,
    hir: moduleView.hir,
    onEnterExpression: (exprId, expr) => {
      if (fallback) {
        return;
      }
      if (
        expr.exprKind === "lambda" &&
        expr.captures?.some((capture) =>
          aliases.aliases(capture.symbol, candidate.root),
        )
      ) {
        reject("local-capture");
        return;
      }
      if (
        expr.exprKind === "object-literal" &&
        expr.entries.some((entry) => {
          const symbol = argumentRootSymbol({
            exprId: entry.value,
            moduleView,
            program,
          });
          return (
            typeof symbol === "number" &&
            aliases.aliases(symbol, candidate.root)
          );
        })
      ) {
        reject("local-retention");
        return;
      }
      if (expr.exprKind === "assign") {
        const symbol = argumentRootSymbol({
          exprId: expr.value,
          moduleView,
          program,
        });
        if (
          typeof symbol === "number" &&
          aliases.aliases(symbol, candidate.root)
        ) {
          reject("local-mutation");
          return;
        }
      }
      if (
        expr.exprKind === "tuple" &&
        expr.elements.some((element) => {
          const symbol = argumentRootSymbol({
            exprId: element,
            moduleView,
            program,
          });
          return (
            typeof symbol === "number" &&
            aliases.aliases(symbol, candidate.root)
          );
        })
      ) {
        reject("local-retention");
        return;
      }
      if (expr.exprKind !== "call" && expr.exprKind !== "method-call") {
        return;
      }
      if (
        expr.exprKind === "call" &&
        isBorrowMarker({ expr, moduleView, program })
      ) {
        return;
      }
      const aliasesRoot = callArgumentExprIds(expr).some((argumentExprId) => {
        const symbol = argumentRootSymbol({
          exprId: argumentExprId,
          moduleView,
          program,
        });
        return (
          typeof symbol === "number" && aliases.aliases(symbol, candidate.root)
        );
      });
      if (!aliasesRoot) {
        return;
      }
      const decision = callHasNoEscape({
        callInfo: calls.get(exprId),
        expr,
        moduleView,
        program,
      });
      if (!decision.accepted) reject(decision.reason);
    },
    onEnterStatement: (_statementId, statement) => {
      if (
        fallback ||
        statement.kind !== "return" ||
        typeof statement.value !== "number"
      ) {
        return;
      }
      const symbol = argumentRootSymbol({
        exprId: statement.value,
        moduleView,
        program,
      });
      if (
        typeof symbol === "number" &&
        aliases.aliases(symbol, candidate.root)
      ) {
        reject("local-result-alias");
      }
    },
  });
  return fallback ? { accepted: false, reason: fallback } : { accepted: true };
};

const assignmentIsDisjoint = ({
  expr,
  candidate,
  aliases,
  moduleView,
}: {
  expr: Extract<HirExpression, { exprKind: "assign" }>;
  candidate: Candidate;
  aliases: AliasGroups;
  moduleView: ReadonlyOptimizedModuleView;
}): boolean => {
  if (typeof expr.target !== "number") {
    return false;
  }
  const target = moduleView.hir.expressions.get(expr.target);
  if (target?.exprKind === "identifier") {
    return !aliases.aliases(target.symbol, candidate.root);
  }
  if (target?.exprKind !== "field-access") {
    return false;
  }
  const root = moduleView.hir.expressions.get(target.target);
  if (
    root?.exprKind !== "identifier" ||
    !aliases.aliases(root.symbol, candidate.root)
  ) {
    return true;
  }
  return target.field !== candidate.field;
};

const isBorrowMarker = ({
  expr,
  moduleView,
  program,
}: {
  expr: Extract<HirExpression, { exprKind: "call" }>;
  moduleView: ReadonlyOptimizedModuleView;
  program: ProgramCodegenView;
}): boolean => {
  const callee = moduleView.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return false;
  }
  const id = program.symbols.idOf({
    moduleId: moduleView.moduleId,
    symbol: callee.symbol,
  });
  return (
    (program.symbols.getIntrinsicName(id) ?? program.symbols.getName(id)) ===
      "~" && program.symbols.getIntrinsicFunctionFlags(id).intrinsic
  );
};

const callHasNoEscape = ({
  callInfo,
  expr,
  moduleView,
  program,
}: {
  callInfo: OptimizedCallInfo | undefined;
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  moduleView: ReadonlyOptimizedModuleView;
  program: ProgramCodegenView;
}): StableFieldCandidateDecision => {
  if (!callInfo) {
    return { accepted: false, reason: "unresolved-target" };
  }
  if (callInfo.traitDispatch) {
    return { accepted: false, reason: "dynamic-dispatch" };
  }
  if (callInfo.identityGuards.length > 0) {
    return { accepted: false, reason: "identity-guard" };
  }
  const facts = resolvedExactFacts({
    callInfo,
    expr,
    moduleView,
    program,
  });
  if (facts.length === 0) {
    return { accepted: false, reason: "exact-fact-unavailable" };
  }
  if (facts.some((fact) => !exactFactHasSafeBoundary(fact))) {
    return { accepted: false, reason: "unsafe-boundary" };
  }
  if (facts.some((fact) => fact.parameters.some((item) => item.escapes))) {
    return { accepted: false, reason: "escape" };
  }
  if (facts.some((fact) => fact.parameters.some((item) => item.retained))) {
    return { accepted: false, reason: "retention" };
  }
  if (
    facts.some((fact) => fact.parameters.some((item) => item.resultAliases))
  ) {
    return { accepted: false, reason: "result-alias" };
  }
  return { accepted: true };
};

const callIsDisjoint = ({
  expr,
  candidate,
  aliases,
  callInfo,
  moduleView,
  program,
}: {
  exprId: HirExprId;
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  candidate: Candidate;
  aliases: AliasGroups;
  callInfo: OptimizedCallInfo | undefined;
  moduleView: ReadonlyOptimizedModuleView;
  program: ProgramCodegenView;
}): StableFieldCandidateDecision => {
  if (
    expr.exprKind === "call" &&
    isBorrowMarker({ expr, moduleView, program })
  ) {
    return { accepted: true };
  }
  if (
    expr.exprKind === "method-call" &&
    callInfo?.traitDispatch &&
    expr.args.length > 0
  ) {
    return { accepted: false, reason: "dynamic-dispatch" };
  }
  const argumentExprIds = callArgumentExprIds(expr);
  const passesRoot = argumentExprIds.some((argumentExprId) => {
    const symbol = argumentRootSymbol({
      exprId: argumentExprId,
      moduleView,
      program,
    });
    return (
      typeof symbol === "number" && aliases.aliases(symbol, candidate.root)
    );
  });
  if (!passesRoot) {
    return { accepted: true };
  }
  const boundary = callHasNoEscape({ callInfo, expr, moduleView, program });
  if (!boundary.accepted) {
    return boundary;
  }
  if (!callInfo) {
    return { accepted: false, reason: "unresolved-target" };
  }
  const targets = resolvedTargetEntries({
    callInfo,
    expr,
    moduleView,
    program,
  });
  if (targets.length === 0) {
    return { accepted: false, reason: "unresolved-target" };
  }
  for (const [callerInstance, target] of targets) {
    const decision = program.exactCallOptimizations.getFact(target);
    const fact = decision.kind === "available" ? decision.fact : undefined;
    const plan = callInfo.argPlans?.get(callerInstance);
    if (!fact || !exactFactHasSafeBoundary(fact)) {
      return {
        accepted: false,
        reason: fact ? "unsafe-boundary" : "exact-fact-unavailable",
      };
    }
    for (const [parameterIndex, parameter] of fact.parameters.entries()) {
      const planned = plan?.[parameterIndex];
      const argumentIndex =
        planned?.kind === "direct"
          ? planned.argIndex
          : plan
            ? undefined
            : parameterIndex;
      if (typeof argumentIndex !== "number") {
        if (parameter.writesWholeValue || parameter.indirectAccess) {
          return { accepted: false, reason: "whole-value-access" };
        }
        if (parameter.writeFields.length > 0) {
          return { accepted: false, reason: "unsupported-argument-plan" };
        }
        continue;
      }
      const argumentExprId = argumentExprIds[argumentIndex];
      const argumentSymbol =
        typeof argumentExprId === "number"
          ? argumentRootSymbol({ exprId: argumentExprId, moduleView, program })
          : undefined;
      if (
        typeof argumentSymbol !== "number" ||
        !aliases.aliases(argumentSymbol, candidate.root)
      ) {
        continue;
      }
      if (
        parameter.readsWholeValue ||
        parameter.writesWholeValue ||
        parameter.indirectAccess
      ) {
        return { accepted: false, reason: "whole-value-access" };
      }
      if (parameter.escapes) {
        return { accepted: false, reason: "escape" };
      }
      if (parameter.retained) {
        return { accepted: false, reason: "retention" };
      }
      if (parameter.resultAliases) {
        return { accepted: false, reason: "result-alias" };
      }
      if (parameter.writeFields.includes(candidate.field)) {
        return { accepted: false, reason: "candidate-field-write" };
      }
    }
  }
  return { accepted: true };
};

const argumentRootSymbol = ({
  exprId,
  moduleView,
  program,
}: {
  exprId: HirExprId;
  moduleView: ReadonlyOptimizedModuleView;
  program: ProgramCodegenView;
}): SymbolId | undefined => {
  const expr = moduleView.hir.expressions.get(exprId);
  if (expr?.exprKind === "identifier") {
    return expr.symbol;
  }
  if (
    expr?.exprKind !== "call" ||
    !isBorrowMarker({ expr, moduleView, program })
  ) {
    return undefined;
  }
  const argument = expr.args[0];
  return argument
    ? argumentRootSymbol({ exprId: argument.expr, moduleView, program })
    : undefined;
};

const resolvedExactFacts = ({
  callInfo,
  expr,
  moduleView,
  program,
}: {
  callInfo: OptimizedCallInfo | undefined;
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  moduleView: ReadonlyOptimizedModuleView;
  program: ProgramCodegenView;
}): readonly ExactCallOptimizationFact[] => {
  if (
    !callInfo ||
    callInfo.traitDispatch ||
    callInfo.identityGuards.length > 0
  ) {
    return [];
  }
  const targets = [
    ...new Set(
      resolvedTargetEntries({ callInfo, expr, moduleView, program }).map(
        ([, target]) => target,
      ),
    ),
  ];
  if (targets.length === 0) {
    return [];
  }
  const facts = targets.flatMap((target) => {
    const decision = program.exactCallOptimizations.getFact(target);
    return decision.kind === "available" ? [decision.fact] : [];
  });
  return facts.length === targets.length ? facts : [];
};

const exactFactHasSafeBoundary = (fact: ExactCallOptimizationFact): boolean =>
  !fact.nestedCall &&
  !fact.recursiveCall &&
  !fact.dynamicCall &&
  !fact.unresolvedCall &&
  !fact.identityGuard &&
  !fact.externalAccess &&
  !fact.maySuspend;

const resolvedTargetEntries = ({
  callInfo,
  expr,
  moduleView,
  program,
}: {
  callInfo: OptimizedCallInfo;
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  moduleView: ReadonlyOptimizedModuleView;
  program: ProgramCodegenView;
}): readonly [ProgramFunctionInstanceId, ProgramFunctionId][] => {
  const resolved = [...(callInfo.targets?.entries() ?? [])];
  if (resolved.length > 0) {
    return resolved;
  }
  // Monomorphic direct calls intentionally omit the per-instance target map;
  // the callee's declaration symbol plus its exact body fact is their
  // resolution proof. Function-value locals have no exact fact and bail out.
  const callee =
    expr.exprKind === "call"
      ? moduleView.hir.expressions.get(expr.callee)
      : undefined;
  const target =
    callee?.exprKind === "identifier"
      ? program.functions.getFunctionId({
          moduleId: moduleView.moduleId,
          symbol: callee.symbol,
        })
      : undefined;
  if (typeof target !== "number") {
    return [];
  }
  const callerInstances = [...(callInfo.argPlans?.keys() ?? [])];
  return callerInstances.length > 0
    ? callerInstances.map((caller) => [caller, target] as const)
    : [[-1 as ProgramFunctionInstanceId, target]];
};

const callArgumentExprIds = (
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>,
): readonly HirExprId[] =>
  expr.exprKind === "method-call"
    ? [expr.target, ...expr.args.map((argument) => argument.expr)]
    : expr.args.map((argument) => argument.expr);
