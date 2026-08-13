import { diagnosticFromCode } from "../../diagnostics/index.js";
import {
  addCompilerPerfPhaseDuration,
  incrementCompilerPerfCounter,
  markCompilerPerfPhaseDuration,
  startCompilerPerfPhase,
} from "../../perf.js";
import type { SymbolTable } from "../binder/index.js";
import type { DeclTable } from "../decls.js";
import type {
  HirFunction,
  HirGraph,
  HirLambdaExpr,
  HirTraitMethod,
  HirVisibility,
} from "../hir/index.js";
import type { HirItemId, SymbolId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import { canonicalSymbolRef } from "../typing/symbol-ref-utils.js";
import {
  extractCallableBorrowIndex,
  type CallableBorrowIndex,
} from "./callable-borrow-index.js";
import {
  resolveBorrowCallTargets,
  type ResolveContext,
} from "./call-resolution.js";
import type { BorrowingDependency } from "./dependency.js";
import type { BorrowingResult } from "./model.js";
import { checkOrdinaryLocalMutationSafety } from "./ordinary-mutation-local.js";
import { planOrdinaryMutationSafety } from "./ordinary-mutation-safety.js";
import {
  OrdinaryParameterAccess,
  extractOrdinaryMutationInput,
  ordinaryMutationSignatureUpperBound,
  solveOrdinaryMutationSummaries,
  validateOrdinaryMutationSummaryBound,
  type OrdinaryMutationBoundViolation,
  type OrdinaryMutationSummary,
} from "./ordinary-mutation-summary.js";
import { checkScopedBorrowLocal } from "./scoped-borrow-local.js";

/**
 * Analyze source-level mutation and scoped borrows with bounded state.
 *
 * Interprocedural safety retains only a whole-parameter finite summary. An
 * explicit `Borrow<T>` origin is a callable-local parameter bit and is
 * discarded when this function returns; no result provenance, projection
 * family, region, or legacy callable contract crosses the module boundary.
 */
export const analyzeBorrowing = ({
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  decls,
  checkBodies = true,
}: {
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: readonly { local: SymbolId; target?: SymbolRef }[];
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  decls: DeclTable;
  checkBodies?: boolean;
}): BorrowingResult => {
  const analysisStartedAt = startCompilerPerfPhase();
  const summaryHir = hirWithTraitDefaultFunctions(hir);
  const functions = Array.from(summaryHir.items.values()).filter(
    (item): item is HirFunction => item.kind === "function",
  );
  const lambdas = Array.from(summaryHir.expressions.values()).filter(
    (expression): expression is HirLambdaExpr =>
      expression.exprKind === "lambda",
  );
  const importMap = new Map(
    imports.flatMap((entry) =>
      entry.target ? ([[entry.local, entry.target]] as const) : [],
    ),
  );
  const resolveContext: ResolveContext = {
    hir: summaryHir,
    typing,
    symbolTable,
    moduleId,
    imports: importMap,
    dependencies,
    bindingInitializers: new Map(),
    borrowIndexMode: "symbolic",
    decls,
  };
  const resolvedCallTargets = new Map(
    Array.from(summaryHir.expressions).flatMap(([expressionId, expression]) =>
      expression.exprKind === "call" || expression.exprKind === "method-call"
        ? [
            [
              expressionId,
              resolveBorrowCallTargets(expression, resolveContext),
            ] as const,
          ]
        : [],
    ),
  );
  const indexes = new Map<SymbolId, CallableBorrowIndex>([
    ...extractCallableBorrowIndex({
      callables: functions,
      hir: summaryHir,
      typing,
      symbolTable,
      decls,
      resolveContext,
      resolvedCallTargets,
    }),
    ...extractCallableBorrowIndex({
      callables: lambdas.map((lambda) => ({
        symbol: (-1 - lambda.id) as SymbolId,
        parameters: lambda.parameters,
        body: lambda.body,
        type: typing.resolvedExprTypes.get(lambda.id),
        captures: lambda.captures,
      })),
      hir: summaryHir,
      typing,
      symbolTable,
      decls,
      resolveContext,
      resolvedCallTargets,
    }),
  ]);

  const ordinaryStartedAt = startCompilerPerfPhase();
  const ordinaryInputs = new Map(
    Array.from(indexes, ([symbol, index]) => [
      symbol,
      extractOrdinaryMutationInput(index),
    ]),
  );
  const importedSummaries = new Map<string, OrdinaryMutationSummary>();
  dependencies.forEach((dependency, dependencyModuleId) =>
    dependency.ordinaryMutationSummaries.forEach((summary, symbol) =>
      importedSummaries.set(`${dependencyModuleId}::${symbol}`, summary),
    ),
  );
  const declarationBounds = buildOrdinaryDeclarationBounds({
    hir,
    typing,
    symbolTable,
    moduleId,
    importMap,
    dependencies,
    inputs: ordinaryInputs,
  });
  const solved = solveOrdinaryMutationSummaries({
    inputs: ordinaryInputs,
    moduleId,
    importedSummaries,
    declarationBounds,
  });
  const ordinaryMutationSummaries = new Map(solved.summaries);
  addDeclarationOrdinaryMutationSummaries({
    hir,
    typing,
    decls,
    symbolTable,
    summaries: ordinaryMutationSummaries,
  });
  const violations = collectOrdinaryMutationViolations({
    indexes,
    summaries: ordinaryMutationSummaries,
    declarationViolations: solved.declarationBoundViolations,
    exclusiveDeclarationSymbols: exclusiveDeclarationSymbolsIn(hir),
  });
  markCompilerPerfPhaseDuration(
    "analyzeBorrowing.ordinaryMutation",
    ordinaryStartedAt,
  );

  const defaultIdentityGuardTargets = new Set(
    Array.from(indexes).flatMap(([symbol, index]) =>
      index.flags.hasDefaultArgument && !index.flags.hasDefaultBorrowFlow
        ? [symbol]
        : [],
    ),
  );
  const qualifiedDefaultIdentityGuardTargets = new Set(
    Array.from(
      defaultIdentityGuardTargets,
      (symbol) => `${moduleId}::${symbol}`,
    ),
  );
  dependencies.forEach((dependency, dependencyModuleId) =>
    dependency.defaultIdentityGuardTargets.forEach((symbol) =>
      qualifiedDefaultIdentityGuardTargets.add(
        `${dependencyModuleId}::${symbol}`,
      ),
    ),
  );

  const diagnostics = checkBodies
    ? [
        ...ordinaryMutationDiagnostics({
          violations,
          functions,
          lambdas,
          symbolTable,
          hir,
        }),
      ]
    : [];
  const runtimeIdentityGuards = new Map<
    number,
    import("./model.js").RuntimeIdentityGuard[]
  >();
  const mutableStorageSymbols = new Set<SymbolId>();
  const functionBySymbol = new Map(
    functions.map((functionItem) => [functionItem.symbol, functionItem]),
  );
  const lambdaBySymbol = new Map(
    lambdas.map((lambda) => [(-1 - lambda.id) as SymbolId, lambda]),
  );
  const explicitBorrowFactCount = Array.from(indexes.values()).reduce(
    (count, index) =>
      count +
      index.parameters.filter((parameter) => {
        if (typeof parameter.type !== "number") return false;
        return (
          typing.arena.get(typing.arena.unfoldRecursive(parameter.type))
            .kind === "borrowed"
        );
      }).length,
    0,
  );
  incrementCompilerPerfCounter(
    "borrowing.explicitBorrowFacts",
    explicitBorrowFactCount,
  );
  incrementCompilerPerfCounter("borrowing.fullFacts.materialized", 0);
  indexes.forEach((index) => {
    if (!checkBodies) return;
    const plan = planOrdinaryMutationSafety({
      index,
      moduleId,
      localSummaries: ordinaryMutationSummaries,
      localIndexes: indexes,
      importedSummaries,
      defaultIdentityGuardTargets: qualifiedDefaultIdentityGuardTargets,
      typing,
      symbolTable,
    });
    plan.mutableStorageSymbols.forEach((symbol) =>
      mutableStorageSymbols.add(symbol),
    );
    plan.guards.forEach((guards, call) =>
      runtimeIdentityGuards.set(call, [...guards]),
    );
    diagnostics.push(...plan.diagnostics);
    const callable =
      functionBySymbol.get(index.symbol) ?? lambdaBySymbol.get(index.symbol);
    if (!callable) return;
    diagnostics.push(
      ...checkOrdinaryLocalMutationSafety({
        body: callable.body,
        callableSpan: callable.span,
        index,
        hir: summaryHir,
        typing,
        symbolTable,
        resolveContext,
        moduleId,
        localSummaries: ordinaryMutationSummaries,
        importedSummaries,
        plannedGuards: plan.guards,
      }),
    );
    const hasExplicitBorrow = index.parameters.some((parameter) => {
      if (typeof parameter.type !== "number") return false;
      return (
        typing.arena.get(typing.arena.unfoldRecursive(parameter.type)).kind ===
        "borrowed"
      );
    });
    const scopedStartedAt = hasExplicitBorrow
      ? startCompilerPerfPhase()
      : undefined;
    diagnostics.push(
      ...checkScopedBorrowLocal({
        body: callable.body,
        callableSpan: callable.span,
        index,
        hir: summaryHir,
        typing,
        symbolTable,
        moduleId,
        localSummaries: ordinaryMutationSummaries,
        importedSummaries,
      }),
    );
    if (scopedStartedAt !== undefined) {
      markCompilerPerfPhaseDuration(
        "analyzeBorrowing.explicitBorrow",
        scopedStartedAt,
      );
    }
  });

  if (explicitBorrowFactCount === 0 || !checkBodies) {
    addCompilerPerfPhaseDuration("analyzeBorrowing.explicitBorrow", 0);
  }
  if (explicitBorrowFactCount === 0) {
    incrementCompilerPerfCounter(
      "borrowing.explicitBorrow.skippedOrdinaryCallables",
      indexes.size,
    );
  }
  markCompilerPerfPhaseDuration(
    "analyzeBorrowing.finiteLocal",
    analysisStartedAt,
  );
  return {
    ordinaryMutationSummaries,
    defaultIdentityGuardTargets,
    runtimeIdentityGuards,
    mutableStorageSymbols,
    diagnostics: deduplicateDiagnostics(diagnostics),
  };
};

const buildOrdinaryDeclarationBounds = ({
  hir,
  typing,
  symbolTable,
  moduleId,
  importMap,
  dependencies,
  inputs,
}: {
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  importMap: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  inputs: ReadonlyMap<SymbolId, unknown>;
}): ReadonlyMap<SymbolId, OrdinaryMutationSummary> => {
  const bounds = new Map<SymbolId, OrdinaryMutationSummary>();
  const localTraitBounds = new Map(
    Array.from(hir.items.values()).flatMap((item) =>
      item.kind === "trait"
        ? item.methods.map(
            (method) =>
              [
                method.symbol,
                ordinaryMutationDeclarationBoundForHirParameters(
                  method.parameters,
                  callableMaySuspend({
                    symbol: method.symbol,
                    fallbackEffectType: method.effectType,
                    typing,
                  }),
                  traitMethodAllowsUnknownCallback(method, typing) ||
                    traitMethodInvokesUnknownCallback(
                      method.symbol,
                      symbolTable,
                    ),
                ),
              ] as const,
          )
        : [],
    ),
  );
  typing.traitMethodImpls.forEach((mapping, implementation) => {
    if (!inputs.has(implementation)) return;
    const canonicalDeclaration = canonicalSymbolRef({
      symbol: mapping.traitMethodSymbol,
      symbolTable,
      moduleId,
    });
    const imported =
      canonicalDeclaration.moduleId === moduleId
        ? importMap.get(mapping.traitMethodSymbol)
        : canonicalDeclaration;
    const declaration =
      localTraitBounds.get(mapping.traitMethodSymbol) ??
      (canonicalDeclaration.moduleId === moduleId
        ? localTraitBounds.get(canonicalDeclaration.symbol)
        : dependencies
            .get(canonicalDeclaration.moduleId)
            ?.ordinaryMutationSummaries.get(canonicalDeclaration.symbol)) ??
      (imported
        ? dependencies
            .get(imported.moduleId)
            ?.ordinaryMutationSummaries.get(imported.symbol)
        : undefined);
    if (declaration) bounds.set(implementation, declaration);
  });
  localTraitBounds.forEach((bound, declaration) => {
    if (inputs.has(declaration)) bounds.set(declaration, bound);
  });
  return bounds;
};

const addDeclarationOrdinaryMutationSummaries = ({
  hir,
  typing,
  decls,
  symbolTable,
  summaries,
}: {
  hir: HirGraph;
  typing: TypingResult;
  decls: DeclTable;
  symbolTable: SymbolTable;
  summaries: Map<SymbolId, OrdinaryMutationSummary>;
}): void => {
  Array.from(hir.items.values()).forEach((item) => {
    if (item.kind === "trait") {
      item.methods.forEach((method) =>
        summaries.set(
          method.symbol,
          ordinaryMutationDeclarationBoundForHirParameters(
            method.parameters,
            callableMaySuspend({
              symbol: method.symbol,
              fallbackEffectType: method.effectType,
              typing,
            }),
            traitMethodAllowsUnknownCallback(method, typing) ||
              traitMethodInvokesUnknownCallback(method.symbol, symbolTable),
          ),
        ),
      );
      return;
    }
    if (item.kind !== "effect") return;
    item.operations.forEach((operation) => {
      if (summaries.has(operation.symbol)) return;
      const signature = ordinaryMutationSignatureForSymbol(
        operation.symbol,
        typing,
      );
      if (!signature) return;
      const maySuspend =
        decls.getEffectOperation(operation.symbol)?.operation.resumable ===
        "resume";
      summaries.set(operation.symbol, {
        ...ordinaryMutationSignatureUpperBound({ signature, maySuspend }),
        ambientObjectAccess: true,
      });
    });
  });
};

const ordinaryMutationUpperBoundForHirParameters = (
  parameters: readonly {
    bindingKind?: "value" | "mutable-ref" | "immutable-ref";
  }[],
): OrdinaryMutationSummary =>
  ordinaryMutationSignatureUpperBound({
    signature: {
      parameters: parameters.map(({ bindingKind }) => ({ bindingKind })),
    } as unknown as Parameters<
      typeof ordinaryMutationSignatureUpperBound
    >[0]["signature"],
  });

const ordinaryMutationDeclarationBoundForHirParameters = (
  parameters: readonly {
    bindingKind?: "value" | "mutable-ref" | "immutable-ref";
  }[],
  maySuspend = false,
  invokesUnknownCallback = false,
): OrdinaryMutationSummary => {
  const parameterBound = ordinaryMutationUpperBoundForHirParameters(parameters);
  return {
    ...parameterBound,
    maySuspend,
    invokesUnknownCallback,
  };
};

const traitMethodInvokesUnknownCallback = (
  symbol: SymbolId,
  symbolTable: SymbolTable,
): boolean => {
  if (!symbolTable.hasSymbol(symbol)) return false;
  const metadata = symbolTable.getSymbol(symbol).metadata as
    | { ordinaryMutationInvokesUnknownCallback?: unknown }
    | undefined;
  return metadata?.ordinaryMutationInvokesUnknownCallback === true;
};

const traitMethodAllowsUnknownCallback = (
  method: HirTraitMethod,
  typing: TypingResult,
): boolean => {
  if (!method.effectType) return true;
  const signature = ordinaryMutationSignatureForSymbol(method.symbol, typing);
  if (signature) return typing.effects.isOpen(signature.effectRow);
  return (
    method.effectType.typeKind === "named" &&
    method.effectType.path.length === 1 &&
    method.effectType.path[0] === "open"
  );
};

const ordinaryMutationSignatureForSymbol = (
  symbol: SymbolId,
  typing: TypingResult,
):
  | Pick<
      import("../typing/index.js").FunctionSignature,
      "parameters" | "effectRow"
    >
  | undefined => {
  const signature = typing.functions.getSignature(symbol);
  if (signature) return signature;
  const type = typing.valueTypes.get(symbol);
  if (typeof type !== "number") return undefined;
  const descriptor = typing.arena.get(typing.arena.unfoldRecursive(type));
  return descriptor.kind === "function"
    ? {
        parameters: descriptor.parameters,
        effectRow: descriptor.effectRow,
      }
    : undefined;
};

const callableMaySuspend = ({
  symbol,
  fallbackEffectType,
  typing,
}: {
  symbol: SymbolId;
  fallbackEffectType?: import("../hir/index.js").HirTypeExpr;
  typing: TypingResult;
}): boolean => {
  // A trait method with no written effect row is effect-open: implementations
  // may refine it with effects. `: ()` is the source spelling for a closed
  // pure declaration and must remain non-suspending.
  if (!fallbackEffectType) return true;
  const signature = ordinaryMutationSignatureForSymbol(symbol, typing);
  if (signature) return !typing.effects.isEmpty(signature.effectRow);
  return !(
    fallbackEffectType.typeKind === "tuple" &&
    fallbackEffectType.elements.length === 0
  );
};

const exclusiveDeclarationSymbolsIn = (hir: HirGraph): ReadonlySet<SymbolId> =>
  new Set(
    Array.from(hir.items.values()).flatMap((item) =>
      item.kind === "trait"
        ? item.methods.flatMap((method) =>
            method.parameters.some(
              (parameter) => parameter.bindingKind === "mutable-ref",
            )
              ? [method.symbol]
              : [],
          )
        : item.kind === "effect"
          ? item.operations.flatMap((operation) =>
              operation.parameters.some(
                (parameter) => parameter.bindingKind === "mutable-ref",
              )
                ? [operation.symbol]
                : [],
            )
          : [],
    ),
  );

const collectOrdinaryMutationViolations = ({
  indexes,
  summaries,
  declarationViolations,
  exclusiveDeclarationSymbols,
}: {
  indexes: ReadonlyMap<SymbolId, CallableBorrowIndex>;
  summaries: ReadonlyMap<SymbolId, OrdinaryMutationSummary>;
  declarationViolations: readonly OrdinaryMutationBoundViolation[];
  exclusiveDeclarationSymbols: ReadonlySet<SymbolId>;
}): readonly OrdinaryMutationBoundViolation[] => {
  const violations = [...declarationViolations];
  const addExclusiveObligations = (
    symbol: SymbolId,
    summary: OrdinaryMutationSummary,
    includeAmbient: boolean,
  ): void => {
    if (includeAmbient && summary.ambientObjectAccess) {
      violations.push({ kind: "ambient-object-access", symbol });
    }
    if (summary.invokesUnknownCallback) {
      violations.push({ kind: "unknown-callback", symbol });
    }
    if (summary.maySuspend) {
      violations.push({ kind: "suspension", symbol });
    }
  };
  indexes.forEach((index, symbol) => {
    const summary = summaries.get(symbol);
    if (!summary) return;
    const parameterBound = {
      ...ordinaryMutationUpperBoundForHirParameters(index.parameters),
      ambientObjectAccess: true,
      invokesUnknownCallback: true,
      maySuspend: true,
    } satisfies OrdinaryMutationSummary;
    violations.push(
      ...validateOrdinaryMutationSummaryBound({
        implementation: summary,
        declaration: parameterBound,
        symbol,
      }),
    );
    if (index.flags.hasMutableParameter) {
      addExclusiveObligations(symbol, summary, false);
    }
  });
  exclusiveDeclarationSymbols.forEach((symbol) => {
    if (indexes.has(symbol)) return;
    const summary = summaries.get(symbol);
    if (summary) addExclusiveObligations(symbol, summary, true);
  });
  return Array.from(
    new Map(
      violations.map((violation) => [JSON.stringify(violation), violation]),
    ).values(),
  );
};

const ordinaryMutationDiagnostics = ({
  violations,
  functions,
  lambdas,
  symbolTable,
  hir,
}: {
  violations: readonly OrdinaryMutationBoundViolation[];
  functions: readonly HirFunction[];
  lambdas: readonly HirLambdaExpr[];
  symbolTable: SymbolTable;
  hir: HirGraph;
}): BorrowingResult["diagnostics"] => {
  const spans = new Map(
    functions.map((functionItem) => [functionItem.symbol, functionItem.span]),
  );
  lambdas.forEach((lambda) =>
    spans.set((-1 - lambda.id) as SymbolId, lambda.span),
  );
  const callableName = (symbol: SymbolId | undefined): string =>
    symbol !== undefined && symbolTable.hasSymbol(symbol)
      ? symbolTable.getSymbol(symbol).name
      : "callback";
  const accessName = (
    access: OrdinaryParameterAccess,
  ): "unused" | "read" | "write" => {
    switch (access) {
      case OrdinaryParameterAccess.Unused:
        return "unused";
      case OrdinaryParameterAccess.Read:
        return "read";
      case OrdinaryParameterAccess.Write:
        return "write";
    }
  };
  return violations.map((violation) => {
    const callable = callableName(violation.symbol);
    const span =
      (violation.symbol === undefined
        ? undefined
        : spans.get(violation.symbol)) ?? hir.module.span;
    switch (violation.kind) {
      case "parameter-count":
        return diagnosticFromCode({
          code: "TY0055",
          params: {
            kind: "ordinary-parameter-count",
            callable,
            actual: violation.actual,
            allowed: violation.allowed,
          },
          span,
        });
      case "parameter-access":
        return diagnosticFromCode({
          code: "TY0055",
          params: {
            kind: "ordinary-parameter-bound",
            callable,
            parameter: violation.parameter,
            actual:
              violation.actual === OrdinaryParameterAccess.Write
                ? "write"
                : "read",
            allowed: accessName(violation.allowed),
          },
          span,
        });
      case "ambient-object-access":
        return diagnosticFromCode({
          code: "TY0055",
          params: { kind: "ordinary-ambient-access", callable },
          span,
        });
      case "unknown-callback":
        return diagnosticFromCode({
          code: "TY0055",
          params: { kind: "ordinary-unknown-callback", callable },
          span,
        });
      case "suspension":
        return diagnosticFromCode({
          code: "TY0055",
          params: { kind: "ordinary-suspension", callable },
          span,
        });
    }
  });
};

const hirWithTraitDefaultFunctions = (hir: HirGraph): HirGraph => {
  const existingSymbols = new Set(
    Array.from(hir.items.values()).flatMap((item) =>
      item.kind === "function" ? [item.symbol] : [],
    ),
  );
  const defaultMethods = Array.from(hir.items.values()).flatMap((item) =>
    item.kind === "trait"
      ? item.methods.flatMap((method) =>
          typeof method.defaultBody === "number" &&
          !existingSymbols.has(method.symbol)
            ? [{ trait: item, method }]
            : [],
        )
      : [],
  );
  if (defaultMethods.length === 0) return hir;
  const items = new Map(hir.items);
  defaultMethods.forEach(({ trait, method }, index) => {
    const id = (-1 - index) as HirItemId;
    items.set(id, {
      kind: "function",
      id,
      ast: method.returnType?.ast ?? trait.ast,
      span: method.span,
      visibility: trait.visibility as HirVisibility,
      symbol: method.symbol,
      typeParameters: method.typeParameters,
      parameters: method.parameters.map((parameter) => ({
        symbol: parameter.symbol,
        pattern: {
          kind: "identifier",
          symbol: parameter.symbol,
          bindingKind: parameter.bindingKind,
          span: parameter.span,
        },
        span: parameter.span,
        label: parameter.label,
        mutable: parameter.mutable,
        type: parameter.type,
      })),
      returnType: method.returnType,
      effectType: method.effectType,
      body: method.defaultBody!,
    });
  });
  return { ...hir, items };
};

const deduplicateDiagnostics = (
  diagnostics: BorrowingResult["diagnostics"],
): BorrowingResult["diagnostics"] =>
  Array.from(
    new Map(
      diagnostics.map((diagnostic) => [
        `${diagnostic.code}:${diagnostic.span.file}:${diagnostic.span.start}:${diagnostic.message}`,
        diagnostic,
      ]),
    ).values(),
  );
