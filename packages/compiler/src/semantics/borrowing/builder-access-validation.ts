import type { BuilderAccess } from "../../builder-access.js";
import { diagnosticFromCode } from "../../diagnostics/index.js";
import { incrementCompilerPerfCounter } from "../../perf.js";
import type { SymbolTable } from "../binder/index.js";
import {
  walkExpression,
  type HirFunction,
  type HirGraph,
  type HirPattern,
} from "../hir/index.js";
import type { Diagnostic, HirExprId, SymbolId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import {
  indexCallArgumentFor,
  type CallableBorrowIndex,
  type CallableBorrowIndexCall,
} from "./callable-borrow-index.js";
import {
  OrdinaryParameterAccess,
  type OrdinaryMutationSummary,
} from "./ordinary-mutation-summary.js";
import { typeCanCarryReference } from "./reference-bearing.js";

type ValidationStats = {
  declarations: number;
  symbols: number;
  originInsertions: number;
  calls: number;
  forwarding: number;
  traitChecks: number;
  violations: number;
};

/**
 * Validate the non-retention promise behind `@access(builder: destination)`.
 *
 * The retained state is one finite parameter-origin bitset per local symbol.
 * Each bit is inserted at most once, so recursive forwarding does not grow the
 * analysis with call-graph or projection depth.
 */
export const validateBuilderAccessContracts = ({
  functions,
  indexes,
  hir,
  typing,
  symbolTable,
  localSummaries,
}: {
  functions: readonly HirFunction[];
  indexes: ReadonlyMap<SymbolId, CallableBorrowIndex>;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  localSummaries: ReadonlyMap<SymbolId, OrdinaryMutationSummary>;
}): readonly Diagnostic[] => {
  const diagnostics: Diagnostic[] = [];
  const stats: ValidationStats = {
    declarations: 0,
    symbols: 0,
    originInsertions: 0,
    calls: 0,
    forwarding: 0,
    traitChecks: 0,
    violations: 0,
  };
  const inherited = inheritTraitContracts({
    functions,
    indexes,
    typing,
    symbolTable,
    diagnostics,
    stats,
  });

  functions.forEach((fn) => {
    const contract = fn.builderAccess ?? inherited.get(fn.symbol);
    const index = indexes.get(fn.symbol);
    if (!contract || !index) return;
    stats.declarations += 1;
    const signature = typing.functions.getSignature(fn.symbol);
    const destination = index.parameters[contract.destinationParameterIndex];
    const summary = localSummaries.get(fn.symbol);
    const invalidReason =
      destination?.bindingKind !== "mutable-ref"
        ? "the destination must be a mutable-reference parameter"
        : !signature || !typing.effects.isEmpty(signature.effectRow)
          ? "the declaration must have an empty effect row"
          : !summary
            ? "the callable body could not be summarized"
            : summary.ambientAccess !== OrdinaryParameterAccess.Unused
              ? "the body may access ambient mutable state"
              : summary.reentrant
                ? "the body may invoke an unknown or reentrant callback"
                : summary.maySuspend
                  ? "the body may suspend"
                  : undefined;
    if (invalidReason) {
      diagnostics.push(
        builderDiagnostic({ fn, symbolTable, reason: invalidReason }),
      );
      stats.violations += 1;
      return;
    }

    const origins = collectOrigins({ body: fn.body, index, hir, typing });
    stats.symbols += origins.bySymbol.size;
    stats.originInsertions += origins.insertions;
    const failure = findRetentionFailure({
      fn,
      contract,
      index,
      hir,
      typing,
      origins: origins.bySymbol,
      stats,
    });
    if (!failure) return;
    diagnostics.push(
      builderDiagnostic({
        fn,
        symbolTable,
        reason: failure.reason,
        span:
          failure.expression === undefined
            ? undefined
            : hir.expressions.get(failure.expression)?.span,
      }),
    );
    stats.violations += 1;
  });

  recordStats(stats);
  return diagnostics;
};

const inheritTraitContracts = ({
  functions,
  indexes,
  typing,
  symbolTable,
  diagnostics,
  stats,
}: {
  functions: readonly HirFunction[];
  indexes: ReadonlyMap<SymbolId, CallableBorrowIndex>;
  typing: TypingResult;
  symbolTable: SymbolTable;
  diagnostics: Diagnostic[];
  stats: ValidationStats;
}): ReadonlyMap<SymbolId, BuilderAccess> => {
  const inherited = new Map<SymbolId, BuilderAccess>();
  typing.traitMethodImpls.forEach((mapping, implementation) => {
    const declaration = typing.traits
      .getDecl(mapping.traitSymbol)
      ?.methods.find((method) => method.symbol === mapping.traitMethodSymbol);
    const expected = declaration?.builderAccess;
    if (!expected) return;
    stats.traitChecks += 1;
    const signature = typing.functions.getSignature(implementation);
    const explicit = signature?.builderAccess;
    if (explicit && !sameContract(expected, explicit)) {
      const fn = functions.find(
        (candidate) => candidate.symbol === implementation,
      );
      diagnostics.push(
        diagnosticFromCode({
          code: "TY0058",
          params: {
            kind: "invalid-builder-contract",
            callable: symbolName(implementation, symbolTable),
            reason: `trait implementation declares a different @access(builder: ...) destination than parameter ${expected.destinationParameterIndex + 1}`,
          },
          span: fn?.span ?? declaration.span,
        }),
      );
      stats.violations += 1;
      return;
    }
    inherited.set(implementation, expected);
    if (signature && !signature.builderAccess)
      signature.builderAccess = expected;
    const index = indexes.get(implementation);
    if (index?.signature && !index.signature.builderAccess) {
      index.signature.builderAccess = expected;
    }
  });
  return inherited;
};

const collectOrigins = ({
  body,
  index,
  hir,
  typing,
}: {
  body: HirExprId;
  index: CallableBorrowIndex;
  hir: HirGraph;
  typing: TypingResult;
}): {
  bySymbol: ReadonlyMap<SymbolId, ReadonlySet<number>>;
  insertions: number;
} => {
  const bySymbol = new Map<SymbolId, Set<number>>();
  index.parameterPlaces.forEach(({ parameter }, symbol) =>
    bySymbol.set(symbol, new Set([parameter])),
  );
  const transfers: { symbols: readonly SymbolId[]; value: HirExprId }[] = [];
  walkExpression({
    exprId: body,
    hir,
    options: { skipLambdas: true },
    onEnterStatement: (_id, statement) => {
      if (statement.kind !== "let") return;
      transfers.push({
        symbols: patternSymbols(statement.pattern),
        value: statement.initializer,
      });
    },
    onEnterExpression: (_id, expression) => {
      if (expression.exprKind !== "assign" || !expression.pattern) return;
      transfers.push({
        symbols: patternSymbols(expression.pattern),
        value: expression.value,
      });
    },
  });
  const calls = new Map(index.calls.map((call) => [call.exprId, call]));
  const boundSymbols = new Set(
    transfers.flatMap((transfer) => transfer.symbols),
  );
  const parameterCount = Math.max(1, index.parameters.length);
  const insertionBound = Math.max(1, boundSymbols.size * parameterCount);
  let insertions = 0;
  let changed = true;
  while (changed && insertions <= insertionBound) {
    changed = false;
    const memo = new Map<HirExprId, ReadonlySet<number>>();
    transfers.forEach((transfer) => {
      const values = expressionOrigins({
        expressionId: transfer.value,
        bySymbol,
        calls,
        hir,
        typing,
        memo,
        active: new Set(),
      });
      transfer.symbols.forEach((symbol) => {
        const current = bySymbol.get(symbol) ?? new Set<number>();
        values.forEach((value) => {
          if (current.has(value)) return;
          current.add(value);
          insertions += 1;
          changed = true;
        });
        if (current.size > 0) bySymbol.set(symbol, current);
      });
    });
  }
  if (insertions > insertionBound) {
    throw new Error("builder origin analysis exceeded its finite bound");
  }
  return { bySymbol, insertions };
};

const findRetentionFailure = ({
  fn,
  contract,
  index,
  hir,
  typing,
  origins,
  stats,
}: {
  fn: HirFunction;
  contract: BuilderAccess;
  index: CallableBorrowIndex;
  hir: HirGraph;
  typing: TypingResult;
  origins: ReadonlyMap<SymbolId, ReadonlySet<number>>;
  stats: ValidationStats;
}): { expression?: HirExprId; reason: string } | undefined => {
  const sourceParameters = new Set(
    index.parameters.flatMap((parameter) =>
      parameter.parameter !== contract.destinationParameterIndex &&
      parameter.referenceCapable === true
        ? [parameter.parameter]
        : [],
    ),
  );
  const calls = new Map(index.calls.map((call) => [call.exprId, call]));
  const expressionOriginCache = new Map<HirExprId, ReadonlySet<number>>();
  const originsOf = (expression: HirExprId): ReadonlySet<number> =>
    expressionOrigins({
      expressionId: expression,
      bySymbol: origins,
      calls,
      hir,
      typing,
      memo: expressionOriginCache,
      active: new Set(),
    });
  const hasSource = (values: ReadonlySet<number>): boolean =>
    Array.from(values).some((value) => sourceParameters.has(value));
  const hasDestination = (values: ReadonlySet<number>): boolean =>
    values.has(contract.destinationParameterIndex);
  let failure: { expression?: HirExprId; reason: string } | undefined;

  walkExpression({
    exprId: fn.body,
    hir,
    options: { skipLambdas: true },
    onEnterStatement: (_id, statement) => {
      if (failure) return { stop: true };
      if (
        statement.kind === "return" &&
        typeof statement.value === "number" &&
        hasSource(originsOf(statement.value))
      ) {
        failure = {
          expression: statement.value,
          reason: "a reference-bearing source may be returned",
        };
        return { stop: true };
      }
    },
    onEnterExpression: (expressionId, expression, context) => {
      if (failure) return { stop: true };
      if (context.tailPosition && hasSource(originsOf(expressionId))) {
        failure = {
          expression: expressionId,
          reason: "a reference-bearing source may be returned",
        };
        return { stop: true };
      }
      if (expression.exprKind === "lambda") {
        if (
          expression.captures.some((capture) =>
            hasSource(origins.get(capture.symbol) ?? new Set()),
          )
        ) {
          failure = {
            expression: expressionId,
            reason: "a reference-bearing source may be captured by a closure",
          };
          return { stop: true };
        }
        return;
      }
      if (
        expression.exprKind === "assign" &&
        typeof expression.target === "number" &&
        hasDestination(originsOf(expression.target)) &&
        hasSource(originsOf(expression.value))
      ) {
        failure = {
          expression: expressionId,
          reason: "a reference-bearing source may be retained in the builder",
        };
        return { stop: true };
      }
      const call = calls.get(expressionId);
      if (!call) return;
      stats.calls += 1;
      const destinationArguments = call.arguments.filter((argument) => {
        if (typeof argument.expression !== "number") return false;
        const bindingKind =
          call.signature?.parameters[argument.parameter]?.bindingKind ??
          argument.bindingKind;
        return (
          (bindingKind === "mutable-ref" ||
            ((call.intrinsicName === "__array_set" ||
              call.intrinsicName === "__array_copy") &&
              argument.parameter === 0)) &&
          hasDestination(originsOf(argument.expression))
        );
      });
      if (destinationArguments.length === 0) return;
      const readsSource = call.arguments.some(
        (argument) =>
          typeof argument.expression === "number" &&
          argument.parameter !==
            call.signature?.builderAccess?.destinationParameterIndex &&
          hasSource(originsOf(argument.expression)),
      );
      if (!readsSource) return;
      if (compatibleBuilderForwarding({ call, contract, originsOf })) {
        stats.forwarding += 1;
        return;
      }
      failure = {
        expression: expressionId,
        reason:
          "a call may retain a reference-bearing source in the builder; use an exact compatible @access(builder: ...) callee",
      };
      return { stop: true };
    },
  });
  return failure;
};

const compatibleBuilderForwarding = ({
  call,
  contract,
  originsOf,
}: {
  call: CallableBorrowIndexCall;
  contract: BuilderAccess;
  originsOf: (expression: HirExprId) => ReadonlySet<number>;
}): boolean => {
  if (
    call.openTraitDispatch ||
    call.ordinaryDynamicBound ||
    call.argumentPlanAmbiguous ||
    call.targets.length !== 1 ||
    call.maySuspend
  ) {
    return false;
  }
  const forwarded = call.signature?.builderAccess;
  if (!forwarded) return false;
  const destination = indexCallArgumentFor(
    call,
    forwarded.destinationParameterIndex,
  );
  return Boolean(
    typeof destination?.expression === "number" &&
    originsOf(destination.expression).has(contract.destinationParameterIndex),
  );
};

const expressionOrigins = ({
  expressionId,
  bySymbol,
  calls,
  hir,
  typing,
  memo,
  active,
}: {
  expressionId: HirExprId;
  bySymbol: ReadonlyMap<SymbolId, ReadonlySet<number>>;
  calls: ReadonlyMap<HirExprId, CallableBorrowIndexCall>;
  hir: HirGraph;
  typing: TypingResult;
  memo: Map<HirExprId, ReadonlySet<number>>;
  active: ReadonlySet<HirExprId>;
}): ReadonlySet<number> => {
  const cached = memo.get(expressionId);
  if (cached) return cached;
  if (active.has(expressionId)) return new Set();
  const type =
    typing.resolvedExprTypes.get(expressionId) ??
    typing.borrowResolvedExprTypes.get(expressionId);
  if (typeof type === "number" && !typeCanCarryReference(type, typing)) {
    return new Set();
  }
  const expression = hir.expressions.get(expressionId);
  if (!expression) return new Set();
  const nextActive = new Set(active).add(expressionId);
  const merge = (children: readonly HirExprId[]): ReadonlySet<number> =>
    new Set(
      children.flatMap((child) =>
        Array.from(
          expressionOrigins({
            expressionId: child,
            bySymbol,
            calls,
            hir,
            typing,
            memo,
            active: nextActive,
          }),
        ),
      ),
    );
  let result: ReadonlySet<number>;
  switch (expression.exprKind) {
    case "literal":
    case "overload-set":
    case "continue":
      result = new Set();
      break;
    case "identifier":
      result = bySymbol.get(expression.symbol) ?? new Set();
      break;
    case "field-access":
      result = merge([expression.target]);
      break;
    case "tuple":
      result = merge(expression.elements);
      break;
    case "object-literal":
      result = merge(expression.entries.map((entry) => entry.value));
      break;
    case "call":
    case "method-call": {
      const call = calls.get(expressionId);
      result =
        call?.signature?.resultIdentity?.kind === "detached"
          ? new Set()
          : merge(
              expression.exprKind === "call"
                ? expression.args.map((argument) => argument.expr)
                : [
                    expression.target,
                    ...expression.args.map((argument) => argument.expr),
                  ],
            );
      break;
    }
    case "assign":
      result = merge([expression.value]);
      break;
    case "block":
      result =
        typeof expression.value === "number"
          ? merge([expression.value])
          : new Set();
      break;
    case "if":
    case "cond":
      result = merge([
        ...expression.branches.map((branch) => branch.value),
        ...(typeof expression.defaultBranch === "number"
          ? [expression.defaultBranch]
          : []),
      ]);
      break;
    case "match":
      result = merge(expression.arms.map((arm) => arm.value));
      break;
    case "break":
      result =
        typeof expression.value === "number"
          ? merge([expression.value])
          : new Set();
      break;
    case "effect-handler":
      result = merge([
        expression.body,
        ...expression.handlers.map((handler) => handler.body),
        ...(typeof expression.finallyBranch === "number"
          ? [expression.finallyBranch]
          : []),
      ]);
      break;
    case "lambda":
      result = new Set(
        expression.captures.flatMap((capture) =>
          Array.from(bySymbol.get(capture.symbol) ?? []),
        ),
      );
      break;
    case "loop":
    case "while":
      result = merge([expression.body]);
      break;
  }
  memo.set(expressionId, result);
  return result;
};

const patternSymbols = (pattern: HirPattern): readonly SymbolId[] => {
  switch (pattern.kind) {
    case "identifier":
      return [pattern.symbol];
    case "tuple":
      return pattern.elements.flatMap(patternSymbols);
    case "destructure":
      return [
        ...pattern.fields.flatMap((field) => patternSymbols(field.pattern)),
        ...(pattern.spread ? patternSymbols(pattern.spread) : []),
      ];
    case "type":
      return pattern.binding ? patternSymbols(pattern.binding) : [];
    case "wildcard":
      return [];
  }
};

const sameContract = (
  left: BuilderAccess,
  right: BuilderAccess | undefined,
): boolean =>
  right !== undefined &&
  left.destinationParameterIndex === right.destinationParameterIndex;

const builderDiagnostic = ({
  fn,
  symbolTable,
  reason,
  span,
}: {
  fn: HirFunction;
  symbolTable: SymbolTable;
  reason: string;
  span?: Diagnostic["span"];
}): Diagnostic =>
  diagnosticFromCode({
    code: "TY0058",
    params: {
      kind: "invalid-builder-contract",
      callable: symbolName(fn.symbol, symbolTable),
      reason,
    },
    span: span ?? fn.span,
  });

const symbolName = (symbol: SymbolId, symbolTable: SymbolTable): string =>
  symbolTable.hasSymbol(symbol)
    ? symbolTable.getSymbol(symbol).name
    : `callable#${symbol}`;

const recordStats = (stats: ValidationStats): void => {
  incrementCompilerPerfCounter(
    "borrowing.builder.declarations",
    stats.declarations,
  );
  incrementCompilerPerfCounter("borrowing.builder.symbols", stats.symbols);
  incrementCompilerPerfCounter(
    "borrowing.builder.originInsertions",
    stats.originInsertions,
  );
  incrementCompilerPerfCounter("borrowing.builder.calls", stats.calls);
  incrementCompilerPerfCounter(
    "borrowing.builder.forwarding",
    stats.forwarding,
  );
  incrementCompilerPerfCounter(
    "borrowing.builder.traitChecks",
    stats.traitChecks,
  );
  incrementCompilerPerfCounter(
    "borrowing.builder.violations",
    stats.violations,
  );
};
