import type {
  HirExpression,
  HirFunction,
  HirGraph,
  HirLambdaExpr,
  HirPattern,
} from "../hir/index.js";
import { walkExpression } from "../hir/index.js";
import type { HirExprId, SymbolId, TypeId } from "../ids.js";
import type { FunctionSignature, TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import { incrementCompilerPerfCounter } from "../../perf.js";
import {
  expressionTypeFor,
  projectedTypes,
  resolveBorrowCall,
  resolveBorrowCallForFacts,
  type ResolveContext,
} from "./call-resolution.js";
import type {
  BorrowEndpointAccess,
  CallableBorrowContract,
  PlaceProjection,
} from "./model.js";
import { translateProjectionPath } from "./model.js";
import { objectLiteralFieldProvider } from "./object-literal-providers.js";
import {
  referenceOriginsInType,
  typeCanCarryReference,
  typeIsAllocationBacked,
} from "./reference-bearing.js";

export type ResultProvenanceKind =
  | "owned"
  | "parameter"
  | "module"
  | "external"
  | "mixed"
  | "unknown";

export type ResultProvenanceOrigin =
  | { kind: "owned" }
  | {
      kind: "parameter";
      parameter: number;
      source: readonly PlaceProjection[];
    }
  | { kind: "module" }
  | { kind: "external" }
  | { kind: "unknown" };

export type ResultProjectionProvenance = {
  path: readonly PlaceProjection[];
  endpointAccess: BorrowEndpointAccess;
  origins: readonly ResultProvenanceOrigin[];
};

export type CallableResultProvenance = {
  kind: ResultProvenanceKind;
  projections: readonly ResultProjectionProvenance[];
};

type ResultCallable = Pick<HirFunction, "symbol" | "parameters" | "body"> & {
  type?: TypeId;
};

type PreparedResultCallable = {
  callable: ResultCallable;
  signature: Pick<FunctionSignature, "parameters" | "returnType" | "effectRow">;
  bindings: ReadonlyMap<SymbolId, BindingSource>;
  resultValues: readonly HirExprId[];
};

type BindingSource =
  | {
      kind: "parameter";
      parameter: number;
      path: readonly PlaceProjection[];
    }
  | {
      kind: "expression";
      expression: HirExprId;
      path: readonly PlaceProjection[];
    }
  | { kind: "unknown" };

type PatternBindingSource =
  | {
      kind: "parameter";
      parameter: number;
      path?: readonly PlaceProjection[];
    }
  | {
      kind: "expression";
      expression: HirExprId;
      path?: readonly PlaceProjection[];
    }
  | { kind: "unknown"; path?: readonly PlaceProjection[] };

// Keep the publication lattice finite for recursive aggregate types. This
// matches the projection bound used by reference-origin and full-summary
// analysis; exceeding it loses precision and therefore stays on the safe path.
const MAX_RESULT_PROVENANCE_DEPTH = 8;
const MAX_RESULT_PROVENANCE_EVALUATIONS = 8;

const pathKey = (path: readonly PlaceProjection[]): string =>
  path
    .map((projection) => {
      switch (projection.kind) {
        case "field":
          return `f:${projection.name}`;
        case "tuple":
          return `t:${projection.index}`;
        case "index":
          return "i";
        case "dereference":
          return "d";
        case "identity":
          return "r";
      }
    })
    .join("/");

const originKey = (origin: ResultProvenanceOrigin): string =>
  origin.kind === "parameter"
    ? `parameter:${origin.parameter}:${pathKey(origin.source)}`
    : origin.kind;

const uniqueOrigins = (
  origins: readonly ResultProvenanceOrigin[],
): readonly ResultProvenanceOrigin[] =>
  Array.from(
    new Map(origins.map((origin) => [originKey(origin), origin])).values(),
  );

const provenanceKind = (
  projections: readonly ResultProjectionProvenance[],
): ResultProvenanceKind => {
  const origins = projections.flatMap((projection) => projection.origins);
  if (origins.some((origin) => origin.kind === "unknown")) return "unknown";
  const kinds = new Set(origins.map((origin) => origin.kind));
  if (kinds.size === 0) return "unknown";
  if (kinds.size > 1) return "mixed";
  return kinds.values().next().value as Exclude<
    ResultProvenanceKind,
    "mixed" | "unknown"
  >;
};

const sameProvenance = (
  left: CallableResultProvenance | undefined,
  right: CallableResultProvenance,
): boolean =>
  left?.kind === right.kind &&
  left.projections.length === right.projections.length &&
  left.projections.every((projection, index) => {
    const candidate = right.projections[index];
    return (
      candidate !== undefined &&
      projection.endpointAccess === candidate.endpointAccess &&
      pathKey(projection.path) === pathKey(candidate.path) &&
      projection.origins.length === candidate.origins.length &&
      projection.origins.every(
        (origin, originIndex) =>
          originKey(origin) === originKey(candidate.origins[originIndex]!),
      )
    );
  });

const patternBindings = ({
  pattern,
  source,
  path = [],
}: {
  pattern: HirPattern;
  source: PatternBindingSource;
  path?: readonly PlaceProjection[];
}): readonly [SymbolId, BindingSource][] => {
  switch (pattern.kind) {
    case "identifier":
      return [
        [
          pattern.symbol,
          source.kind === "parameter"
            ? {
                kind: "parameter",
                parameter: source.parameter,
                path: [...(source.path ?? []), ...path],
              }
            : source.kind === "expression"
              ? {
                  kind: "expression",
                  expression: source.expression,
                  path: [...(source.path ?? []), ...path],
                }
              : { kind: "unknown" },
        ],
      ];
    case "tuple":
      return pattern.elements.flatMap((element, index) =>
        patternBindings({
          pattern: element,
          source,
          path: [...path, { kind: "tuple", index }],
        }),
      );
    case "destructure":
      return [
        ...pattern.fields.flatMap((field) =>
          patternBindings({
            pattern: field.pattern,
            source,
            path: [...path, { kind: "field", name: field.name }],
          }),
        ),
        ...(pattern.spread
          ? patternBindings({ pattern: pattern.spread, source, path })
          : []),
      ];
    case "type":
      return pattern.binding
        ? patternBindings({ pattern: pattern.binding, source, path })
        : [];
    case "wildcard":
      return [];
  }
};

const signatureFor = (
  callable: ResultCallable,
  typing: TypingResult,
):
  | Pick<FunctionSignature, "parameters" | "returnType" | "effectRow">
  | undefined => {
  const direct = typing.functions.getSignature(callable.symbol);
  if (direct) return direct;
  if (typeof callable.type !== "number") return undefined;
  const descriptor = typing.arena.get(callable.type);
  return descriptor.kind === "function"
    ? {
        parameters: descriptor.parameters,
        returnType: descriptor.returnType,
        effectRow: descriptor.effectRow,
      }
    : undefined;
};

const emptyContract = (
  signature: Pick<FunctionSignature, "parameters" | "returnType" | "effectRow">,
  typing: TypingResult,
): CallableBorrowContract => ({
  parameters: signature.parameters.map((parameter) => ({
    access:
      parameter.bindingKind === "mutable-ref"
        ? "mutable"
        : typeCanCarryReference(parameter.type, typing)
          ? "shared"
          : "owned",
    retained: false,
    returned: false,
  })),
  maySuspend: !typing.effects.isEmpty(signature.effectRow),
  borrowedResult: "none",
});

/** Publish only caller-visible result facts; local control-flow state stays private. */
export const contractWithResultProvenance = ({
  contract,
  provenance,
}: {
  contract: CallableBorrowContract;
  provenance: CallableResultProvenance;
}): CallableBorrowContract => {
  const ownedReturnedOrigins = provenance.projections.flatMap((projection) =>
    projection.path.length > 0 &&
    projection.origins.length > 0 &&
    projection.origins.every((origin) => origin.kind === "owned")
      ? [
          {
            result: projection.path,
            endpointAccess: projection.endpointAccess,
            fresh: true as const,
          },
        ]
      : [],
  );
  const externalReturnedOrigins = Array.from(
    new Map(
      [
        ...(contract.externalReturnedOrigins ?? []),
        ...ownedReturnedOrigins,
      ].map((origin) => [
        `${pathKey(origin.result)}:${origin.endpointAccess}:${origin.fresh === true}`,
        origin,
      ]),
    ).values(),
  );
  const rootIsOwned = provenance.projections.some(
    (projection) =>
      projection.path.length === 0 &&
      projection.origins.length > 0 &&
      projection.origins.every((origin) => origin.kind === "owned"),
  );
  return {
    ...contract,
    ...(externalReturnedOrigins.length > 0 ? { externalReturnedOrigins } : {}),
    ...(rootIsOwned || contract.freshResult === true
      ? { freshResult: true as const }
      : {}),
  };
};

const summaryFromContract = (
  contract: CallableBorrowContract,
  resultType: TypeId,
  typing: TypingResult,
  externalKind: "module" | "external",
): CallableResultProvenance => {
  const projections = referenceOriginsInType(resultType, typing).map(
    ({ path, endpointAccess }) => {
      const origins: ResultProvenanceOrigin[] = [];
      contract.parameters.forEach((parameter, parameterIndex) =>
        parameter.returnedOrigins?.forEach((origin) => {
          const source = translateProjectionPath({
            result: origin.result,
            source: origin.source,
            requested: path,
          });
          if (source) {
            origins.push({
              kind: "parameter",
              parameter: parameterIndex,
              source,
            });
          }
        }),
      );
      contract.externalReturnedOrigins?.forEach((origin) => {
        if (
          translateProjectionPath({
            result: origin.result,
            source: [],
            requested: path,
          })
        ) {
          origins.push(
            origin.fresh === true ? { kind: "owned" } : { kind: externalKind },
          );
        }
      });
      if (path.length === 0 && contract.freshResult === true) {
        origins.push({ kind: "owned" });
      }
      if (origins.length === 0 && contract.borrowedResult === "parameter") {
        origins.push({ kind: "unknown" });
      }
      if (origins.length === 0 && contract.borrowedResult === "external") {
        origins.push({ kind: externalKind });
      }
      return { path, endpointAccess, origins: uniqueOrigins(origins) };
    },
  );
  return { kind: provenanceKind(projections), projections };
};

const unknownSummary = (
  resultType: TypeId,
  typing: TypingResult,
): CallableResultProvenance => ({
  kind: "unknown",
  projections: referenceOriginsInType(resultType, typing).map(
    ({ path, endpointAccess }) => ({
      path,
      endpointAccess,
      origins: [{ kind: "unknown" }],
    }),
  ),
});

const collectCallableBindings = ({
  callable,
  hir,
}: {
  callable: ResultCallable;
  hir: HirGraph;
}): {
  bindings: ReadonlyMap<SymbolId, BindingSource>;
  returns: readonly HirExprId[];
} => {
  const bindings = new Map<SymbolId, BindingSource>();
  callable.parameters.forEach((parameter, parameterIndex) =>
    patternBindings({
      pattern: parameter.pattern,
      source: { kind: "parameter", parameter: parameterIndex },
    }).forEach(([symbol, source]) => bindings.set(symbol, source)),
  );
  const assigned = new Set<SymbolId>();
  const returns: HirExprId[] = [];
  const assignedRoot = (expressionId: HirExprId): SymbolId | undefined => {
    const expression = hir.expressions.get(expressionId);
    if (expression?.exprKind === "identifier") return expression.symbol;
    return expression?.exprKind === "field-access"
      ? assignedRoot(expression.target)
      : undefined;
  };
  walkExpression({
    exprId: callable.body,
    hir,
    options: { skipLambdas: true },
    onEnterStatement: (_statementId, statement) => {
      if (statement.kind === "return" && typeof statement.value === "number") {
        returns.push(statement.value);
      }
      if (statement.kind !== "let") return;
      const source =
        statement.mutable === true ||
        statement.pattern.bindingKind === "mutable-ref"
          ? ({ kind: "unknown" } as const)
          : ({
              kind: "expression" as const,
              expression: statement.initializer,
            } as const);
      patternBindings({ pattern: statement.pattern, source }).forEach(
        ([symbol, binding]) => bindings.set(symbol, binding),
      );
    },
    onEnterExpression: (_expressionId, expression) => {
      if (
        expression.exprKind === "assign" &&
        typeof expression.target === "number"
      ) {
        const root = assignedRoot(expression.target);
        if (typeof root === "number") assigned.add(root);
      }
      if (expression.exprKind !== "match") return;
      expression.arms.forEach((arm) =>
        patternBindings({
          pattern: arm.pattern,
          source: { kind: "expression", expression: expression.discriminant },
        }).forEach(([symbol, source]) => bindings.set(symbol, source)),
      );
    },
  });
  assigned.forEach((symbol) => bindings.set(symbol, { kind: "unknown" }));
  return { bindings, returns };
};

const tailValues = (
  expressionId: HirExprId,
  hir: HirGraph,
): readonly HirExprId[] => {
  const expression = hir.expressions.get(expressionId);
  if (!expression) return [];
  switch (expression.exprKind) {
    case "block":
      return typeof expression.value === "number"
        ? tailValues(expression.value, hir)
        : [];
    case "if":
    case "cond":
      return [
        ...expression.branches.flatMap((branch) =>
          tailValues(branch.value, hir),
        ),
        ...(typeof expression.defaultBranch === "number"
          ? tailValues(expression.defaultBranch, hir)
          : []),
      ];
    case "match":
      return expression.arms.flatMap((arm) => tailValues(arm.value, hir));
    default:
      return [expressionId];
  }
};

const intrinsicName = (
  expression: HirExpression,
  context: ResolveContext,
): string | undefined => {
  if (expression.exprKind !== "call") return undefined;
  const callee = context.hir.expressions.get(expression.callee);
  if (callee?.exprKind !== "identifier") return undefined;
  const record = context.symbolTable.getSymbol(callee.symbol);
  const metadata = record.metadata as
    | { intrinsic?: boolean; intrinsicName?: string }
    | undefined;
  return metadata?.intrinsic === true
    ? (metadata.intrinsicName ?? record.name)
    : undefined;
};

const classifyCallable = ({
  prepared,
  context,
  summaries,
  moduleStorage,
  imports,
  localResultSymbols,
  resolvedCallTargets,
  resolvedCalls,
  dependents,
  contractOrigins,
}: {
  prepared: PreparedResultCallable;
  context: ResolveContext;
  summaries: ReadonlyMap<SymbolId, CallableResultProvenance>;
  moduleStorage: ReadonlySet<SymbolId>;
  imports: ReadonlySet<SymbolId>;
  localResultSymbols: ReadonlySet<SymbolId>;
  resolvedCallTargets: ReadonlyMap<HirExprId, readonly SymbolRef[]>;
  resolvedCalls: Map<HirExprId, ReturnType<typeof resolveBorrowCall>>;
  dependents: Map<SymbolId, Set<SymbolId>>;
  /** Stable, pass-scoped substitutions keyed by call expression and result path. */
  contractOrigins: Map<string, readonly ResultProvenanceOrigin[]>;
}): CallableResultProvenance => {
  const { bindings, resultValues, signature } = prepared;
  const active = new Set<string>();
  const classified = new Map<string, readonly ResultProvenanceOrigin[]>();
  const unknown = (
    reason:
      | "ambiguous-call"
      | "depth-limit"
      | "missing-expression"
      | "missing-field-provider"
      | "missing-result-origin"
      | "unresolved-binding"
      | "unsupported-expression",
  ): readonly ResultProvenanceOrigin[] => {
    incrementCompilerPerfCounter(
      `borrowing.resultProvenance.unknownReason.${reason}`,
    );
    return [{ kind: "unknown" }];
  };

  const classify = (
    expressionId: HirExprId,
    path: readonly PlaceProjection[],
  ): readonly ResultProvenanceOrigin[] => {
    if (path.length > MAX_RESULT_PROVENANCE_DEPTH) {
      return unknown("depth-limit");
    }
    const activeKey = `${expressionId}:${pathKey(path)}`;
    const cached = classified.get(activeKey);
    if (cached) return cached;
    if (active.has(activeKey)) return [];
    active.add(activeKey);
    const expression = context.hir.expressions.get(expressionId);
    const finish = (
      origins: readonly ResultProvenanceOrigin[],
    ): readonly ResultProvenanceOrigin[] => {
      active.delete(activeKey);
      const result = uniqueOrigins(origins);
      classified.set(activeKey, result);
      return result;
    };
    if (!expression) return finish(unknown("missing-expression"));
    if (expression.exprKind === "identifier") {
      const binding = bindings.get(expression.symbol);
      if (binding?.kind === "parameter") {
        const source = [...binding.path, ...path];
        if (source.length > MAX_RESULT_PROVENANCE_DEPTH) {
          return finish(unknown("depth-limit"));
        }
        return finish([
          {
            kind: "parameter",
            parameter: binding.parameter,
            source,
          },
        ]);
      }
      if (binding?.kind === "expression") {
        return finish(classify(binding.expression, [...binding.path, ...path]));
      }
      if (binding?.kind === "unknown") {
        return finish(unknown("unresolved-binding"));
      }
      if (moduleStorage.has(expression.symbol))
        return finish([{ kind: "module" }]);
      if (imports.has(expression.symbol)) return finish([{ kind: "external" }]);
      return finish(unknown("unresolved-binding"));
    }
    if (expression.exprKind === "field-access") {
      const projection = Number.isInteger(Number(expression.field))
        ? ({ kind: "tuple", index: Number(expression.field) } as const)
        : ({ kind: "field", name: expression.field } as const);
      return finish(classify(expression.target, [projection, ...path]));
    }
    if (expression.exprKind === "tuple") {
      const first = path[0];
      return finish(
        first?.kind === "tuple" &&
          expression.elements[first.index] !== undefined
          ? classify(expression.elements[first.index]!, path.slice(1))
          : [{ kind: "unknown" }],
      );
    }
    if (expression.exprKind === "object-literal") {
      const expressionType = expressionTypeFor(expressionId, context);
      if (
        path.length === 0 &&
        typeof expressionType === "number" &&
        typeIsAllocationBacked(expressionType, context.typing)
      ) {
        return finish([{ kind: "owned" }]);
      }
      const first = path[0];
      if (first?.kind !== "field" && first?.kind !== "tuple") {
        return finish([{ kind: "unknown" }]);
      }
      const field = first.kind === "field" ? first.name : String(first.index);
      const provider = objectLiteralFieldProvider({
        expression,
        field,
        spreadProvidesField: (value) => {
          const type = expressionTypeFor(value, context);
          return (
            typeof type === "number" &&
            projectedTypes(type, [first], context.typing).length > 0
          );
        },
      });
      if (!provider) return finish(unknown("missing-field-provider"));
      return finish(
        provider.kind === "field"
          ? classify(provider.value, path.slice(1))
          : classify(provider.value, path),
      );
    }
    if (expression.exprKind === "if" || expression.exprKind === "cond") {
      return finish([
        ...expression.branches.flatMap((branch) =>
          classify(branch.value, path),
        ),
        ...(typeof expression.defaultBranch === "number"
          ? classify(expression.defaultBranch, path)
          : [{ kind: "unknown" } as const]),
      ]);
    }
    if (expression.exprKind === "match") {
      return finish(
        expression.arms.flatMap((arm) => classify(arm.value, path)),
      );
    }
    if (expression.exprKind === "block") {
      return finish(
        typeof expression.value === "number"
          ? classify(expression.value, path)
          : [{ kind: "unknown" }],
      );
    }
    if (
      expression.exprKind === "call" ||
      expression.exprKind === "method-call"
    ) {
      const name = intrinsicName(expression, context);
      if (name === "__array_new" || name === "__array_new_fixed") {
        if (path.length === 0) return finish([{ kind: "owned" }]);
        if (path[0]?.kind === "index") {
          return finish(
            expression.exprKind === "call"
              ? expression.args.flatMap((argument) =>
                  classify(argument.expr, path.slice(1)),
                )
              : [{ kind: "unknown" }],
          );
        }
      }
      const knownTargets = resolvedCallTargets.get(expression.id) ?? [];
      const resolved =
        resolvedCalls.get(expression.id) ??
        (knownTargets.length > 0 &&
        knownTargets.every((target) => target.moduleId === context.moduleId)
          ? resolveBorrowCallForFacts(expression, context)
          : resolveBorrowCall(expression, context));
      resolvedCalls.set(expression.id, resolved);
      const authoritativeBoundary =
        resolved.openTraitDispatch === true ||
        resolved.traitDispatch === true ||
        resolved.targets.length === 0;
      if (
        resolved.argumentPlanAmbiguous === true ||
        (authoritativeBoundary && !resolved.contract)
      ) {
        return finish(unknown("ambiguous-call"));
      }
      const targetOrigins = authoritativeBoundary
        ? []
        : resolved.targets.flatMap((target) => {
            if (target.moduleId === context.moduleId) {
              const callers =
                dependents.get(target.symbol) ?? new Set<SymbolId>();
              callers.add(prepared.callable.symbol);
              dependents.set(target.symbol, callers);
              const summary = summaries.get(target.symbol);
              const projection = summary?.projections.find(
                (candidate) => pathKey(candidate.path) === pathKey(path),
              );
              if (!projection) return [];
              return projection.origins.flatMap((origin) => {
                if (origin.kind !== "parameter") return [origin];
                const argument = resolved.arguments[origin.parameter];
                return typeof argument === "number"
                  ? classify(argument, origin.source)
                  : [{ kind: "unknown" } as const];
              });
            }
            return [];
          });
      if (
        targetOrigins.length > 0 ||
        (!authoritativeBoundary &&
          resolved.targets.every(
            (target) =>
              target.moduleId === context.moduleId &&
              localResultSymbols.has(target.symbol),
          ))
      ) {
        return finish(targetOrigins);
      }
      const contract = resolved.contract;
      if (!contract) return finish([]);
      const contractOriginKey = `${expression.id}:${pathKey(path)}`;
      let abstractOrigins = contractOrigins.get(contractOriginKey);
      if (!abstractOrigins) {
        const computed: ResultProvenanceOrigin[] = [];
        contract.parameters.forEach((parameter, parameterIndex) =>
          parameter.returnedOrigins?.forEach((origin) => {
            const source = translateProjectionPath({
              result: origin.result,
              source: origin.source,
              requested: path,
            });
            if (source) {
              computed.push({
                kind: "parameter",
                parameter: parameterIndex,
                source,
              });
            }
          }),
        );
        contract.externalReturnedOrigins?.forEach((origin) => {
          if (
            translateProjectionPath({
              result: origin.result,
              source: [],
              requested: path,
            })
          ) {
            computed.push(
              origin.fresh === true ? { kind: "owned" } : { kind: "external" },
            );
          }
        });
        if (path.length === 0 && contract.freshResult === true) {
          computed.push({ kind: "owned" });
        }
        abstractOrigins = uniqueOrigins(computed);
        contractOrigins.set(contractOriginKey, abstractOrigins);
      }
      const origins = abstractOrigins.flatMap(
        (origin): readonly ResultProvenanceOrigin[] => {
          if (origin.kind !== "parameter") return [origin];
          const argument = resolved.arguments[origin.parameter];
          return typeof argument === "number"
            ? classify(argument, origin.source)
            : [{ kind: "unknown" }];
        },
      );
      return finish(
        origins.length > 0 ? origins : unknown("missing-result-origin"),
      );
    }
    return finish(unknown("unsupported-expression"));
  };

  const projections = referenceOriginsInType(
    signature.returnType,
    context.typing,
  ).map(({ path, endpointAccess }) => ({
    path,
    endpointAccess,
    origins: uniqueOrigins(
      resultValues.flatMap((expression) => classify(expression, path)),
    ),
  }));
  return { kind: provenanceKind(projections), projections };
};

/**
 * Projection-aware, flow-insensitive result publication. Resolved calls and
 * callable contracts are authoritative; unresolved paths remain unknown so
 * routing retains full flow analysis.
 */
export const inferCallableResultProvenance = ({
  callables,
  hir,
  typing,
  resolveContext,
  baseContracts,
  moduleStorage,
  imports,
  resolvedCallTargets,
}: {
  callables: readonly ResultCallable[];
  hir: HirGraph;
  typing: TypingResult;
  resolveContext: ResolveContext;
  baseContracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  moduleStorage: ReadonlySet<SymbolId>;
  imports: ReadonlySet<SymbolId>;
  resolvedCallTargets: ReadonlyMap<HirExprId, readonly SymbolRef[]>;
}): {
  provenance: ReadonlyMap<SymbolId, CallableResultProvenance>;
  contracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
} => {
  const prepared = new Map(
    callables.flatMap((callable) => {
      const signature = signatureFor(callable, typing);
      if (!signature || !typeCanCarryReference(signature.returnType, typing)) {
        return [];
      }
      const { bindings, returns } = collectCallableBindings({ callable, hir });
      return [
        [
          callable.symbol,
          {
            callable,
            signature,
            bindings,
            resultValues: [...returns, ...tailValues(callable.body, hir)],
          },
        ] as const,
      ];
    }),
  );
  const signatures = new Map(
    Array.from(prepared, ([symbol, entry]) => [symbol, entry.signature]),
  );
  const localResultSymbols = new Set(prepared.keys());
  let provenance = new Map<SymbolId, CallableResultProvenance>();
  baseContracts.forEach((contract, symbol) => {
    const signature = signatures.get(symbol);
    if (!signature || !typeCanCarryReference(signature.returnType, typing))
      return;
    provenance.set(
      symbol,
      summaryFromContract(contract, signature.returnType, typing, "module"),
    );
  });
  const resolutionContracts = new Map(baseContracts);
  prepared.forEach(({ signature }, symbol) => {
    if (resolutionContracts.has(symbol)) return;
    resolutionContracts.set(symbol, emptyContract(signature, typing));
  });
  const context: ResolveContext = {
    ...resolveContext,
    hir,
    typing,
    contracts: resolutionContracts,
    callResolutionCache: new Map(),
  };
  const resolvedCalls = new Map<
    HirExprId,
    ReturnType<typeof resolveBorrowCall>
  >();
  const dependents = new Map<SymbolId, Set<SymbolId>>();
  const contractOrigins = new Map<string, readonly ResultProvenanceOrigin[]>();
  const worklist = Array.from(prepared.keys()).filter(
    (symbol) => !baseContracts.has(symbol),
  );
  const queued = new Set(worklist);
  const evaluationCounts = new Map<SymbolId, number>();
  const widened = new Set<SymbolId>();
  for (let cursor = 0; cursor < worklist.length; cursor += 1) {
    const symbol = worklist[cursor]!;
    queued.delete(symbol);
    const entry = prepared.get(symbol)!;
    const evaluationCount = (evaluationCounts.get(symbol) ?? 0) + 1;
    evaluationCounts.set(symbol, evaluationCount);
    const candidate =
      evaluationCount > MAX_RESULT_PROVENANCE_EVALUATIONS
        ? unknownSummary(entry.signature.returnType, typing)
        : classifyCallable({
            prepared: entry,
            context,
            summaries: provenance,
            moduleStorage,
            imports,
            localResultSymbols,
            resolvedCallTargets,
            resolvedCalls,
            dependents,
            contractOrigins,
          });
    if (evaluationCount > MAX_RESULT_PROVENANCE_EVALUATIONS) {
      widened.add(symbol);
    }
    if (sameProvenance(provenance.get(symbol), candidate)) continue;
    provenance.set(symbol, candidate);
    dependents.get(symbol)?.forEach((caller) => {
      if (queued.has(caller) || widened.has(caller)) return;
      queued.add(caller);
      worklist.push(caller);
    });
  }
  provenance = new Map(
    Array.from(provenance, ([symbol, summary]) => {
      const projections = summary.projections.map((projection) => ({
        ...projection,
        origins:
          projection.origins.length > 0
            ? projection.origins
            : ([{ kind: "unknown" }] as const),
      }));
      return [
        symbol,
        { kind: provenanceKind(projections), projections },
      ] as const;
    }),
  );
  const contracts = new Map(baseContracts);
  provenance.forEach((summary, symbol) => {
    const signature = signatures.get(symbol);
    if (!signature) return;
    contracts.set(
      symbol,
      contractWithResultProvenance({
        contract: baseContracts.get(symbol) ?? emptyContract(signature, typing),
        provenance: summary,
      }),
    );
  });
  return { provenance, contracts };
};

export const callableResultIsOwned = (
  provenance: CallableResultProvenance | undefined,
): boolean => provenance?.kind === "owned";

export const callableResultHasOwnedRoot = (
  provenance: CallableResultProvenance | undefined,
): boolean =>
  provenance?.projections.some(
    (projection) =>
      projection.path.length === 0 &&
      projection.origins.length > 0 &&
      projection.origins.every((origin) => origin.kind === "owned"),
  ) === true;

export const resultCallableFromLambda = (
  lambda: HirLambdaExpr,
  typing: TypingResult,
): ResultCallable => ({
  symbol: (-1 - lambda.id) as SymbolId,
  parameters: lambda.parameters,
  body: lambda.body,
  type: typing.resolvedExprTypes.get(lambda.id),
});
