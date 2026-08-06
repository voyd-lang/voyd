import {
  walkExpression,
  type HirExpression,
  type HirGraph,
} from "../hir/index.js";
import type { HirExprId, SymbolId, TypeId } from "../ids.js";
import type { SymbolTable } from "../binder/index.js";
import type { DeclTable } from "../decls.js";
import type { TypingResult, FunctionSignature } from "../typing/index.js";
import { bindCallArgumentExpressions } from "../typing/call-argument-binding.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type { BorrowingDependency } from "./dependency.js";
import type {
  CallableBorrowContract,
  CheckedNamedBorrowContract,
  PlaceProjection,
  ReturnedBorrowOrigin,
} from "./model.js";
import {
  borrowTypeConditionId,
  mappedAllocationCoversReturnedBorrow,
  mergeCallableBorrowContracts,
  projectionPathCovers,
} from "./model.js";
import {
  referenceOriginsInType,
  retainableReferencePathsInType,
  typeCanCarryReference,
} from "./reference-bearing.js";
import { borrowedPathsInType, typeContainsBorrowed } from "./borrowed-types.js";
import { summarySpanToSourceSpan } from "./callable-summary.js";

export type ResolvedBorrowCall = {
  target?: SymbolRef;
  targets: readonly SymbolRef[];
  signature?: Pick<
    FunctionSignature,
    "parameters" | "returnType" | "effectRow"
  >;
  contract?: CallableBorrowContract;
  arguments: readonly (HirExprId | undefined)[];
  contractSources: readonly import("../ids.js").SourceSpan[];
  argumentPlanAmbiguous?: true;
  traitDispatch?: true;
  openTraitDispatch?: true;
};

export type BorrowCallFactResolution = Pick<
  ResolvedBorrowCall,
  | "targets"
  | "signature"
  | "contractSources"
  | "argumentPlanAmbiguous"
  | "traitDispatch"
  | "openTraitDispatch"
> & {
  intrinsic: boolean;
  intrinsicBoundary: boolean;
  substitutions: readonly { argument?: HirExprId }[];
  baseContract?: CallableBorrowContract;
};

type BorrowCallSignature = Pick<
  FunctionSignature,
  "parameters" | "returnType" | "effectRow"
>;

export const BORROW_IRRELEVANT_VALUE_INTRINSICS = new Set([
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
  "__shift_l",
  "__shift_ru",
  "__bit_and",
  "__bit_or",
  "__bit_xor",
  "__i32_wrap_i64",
  "__i64_extend_u",
  "__i64_extend_s",
  "__i32_trunc_f32_s",
  "__i32_trunc_f64_s",
  "__i64_trunc_f32_s",
  "__i64_trunc_f64_s",
  "__f32_convert_i32_s",
  "__f32_convert_i64_s",
  "__f64_convert_i32_s",
  "__f64_convert_i64_s",
  "__reinterpret_f32_to_i32",
  "__reinterpret_i32_to_f32",
  "__f32_demote_f64",
  "__f64_promote_f32",
  "__floor",
  "__ceil",
  "__round",
  "__trunc",
  "__sqrt",
  "__reinterpret_f64_to_i64",
  "__reinterpret_i64_to_f64",
]);

/** Intrinsics whose borrow footprint is fully described by their operands. */
export const COMPACT_BORROW_INTRINSICS = new Set([
  "~",
  "__shared_cell_value",
  "__array_get",
  "__array_set",
  "__array_copy",
  "__array_new",
  "__array_new_fixed",
  "__array_len",
  "__ref_is_null",
]);

const instantiatedExpressionTypesByTyping = new WeakMap<
  TypingResult,
  ReadonlyMap<HirExprId, TypeId>
>();
const conservativeContractsByTyping = new WeakMap<
  TypingResult,
  Map<string, CallableBorrowContract>
>();

const instantiatedExpressionTypes = (
  typing: TypingResult,
): ReadonlyMap<HirExprId, TypeId> => {
  const cached = instantiatedExpressionTypesByTyping.get(typing);
  if (cached) return cached;
  const candidates = new Map<
    HirExprId,
    { first: TypeId; reference?: TypeId }
  >();
  typing.functionInstanceExprTypes.forEach((types) =>
    types.forEach((type, exprId) => {
      const prior = candidates.get(exprId);
      candidates.set(exprId, {
        first: prior?.first ?? type,
        reference:
          prior?.reference ??
          (typeCanCarryReference(type, typing) ? type : undefined),
      });
    }),
  );
  const resolved = new Map(
    Array.from(candidates, ([exprId, candidate]) => [
      exprId,
      candidate.reference ?? candidate.first,
    ]),
  );
  instantiatedExpressionTypesByTyping.set(typing, resolved);
  return resolved;
};

const resolvedTypeFor = (
  exprId: HirExprId,
  typing: TypingResult,
  preferSymbolic = false,
): number | undefined => {
  const concrete =
    typing.resolvedExprTypes.get(exprId) ?? typing.table.getExprType(exprId);
  const symbolic = typing.borrowResolvedExprTypes.get(exprId);
  const direct = preferSymbolic ? (symbolic ?? concrete) : concrete;
  if (typeof direct === "number") {
    return direct;
  }
  return instantiatedExpressionTypes(typing).get(exprId) ?? symbolic;
};

const conservativeContractFor = (
  signature: BorrowCallSignature,
  typing: TypingResult,
  mayRetain = false,
): CallableBorrowContract => {
  const cache =
    conservativeContractsByTyping.get(typing) ??
    new Map<string, CallableBorrowContract>();
  conservativeContractsByTyping.set(typing, cache);
  const key = JSON.stringify([
    signature.parameters.map((parameter) => [
      parameter.type,
      parameter.bindingKind,
    ]),
    signature.returnType,
    signature.effectRow,
    mayRetain,
  ]);
  const cached = cache.get(key);
  if (cached) return cached;
  const returnsReference = typeCanCarryReference(signature.returnType, typing);
  const resultOrigins = returnsReference
    ? referenceOriginsInType(signature.returnType, typing)
    : [];
  const borrowedResultPaths = borrowedPathsInType(signature.returnType, typing);
  const pathOverlaps = (
    left: readonly PlaceProjection[],
    right: readonly PlaceProjection[],
  ): boolean =>
    projectionPathCovers(left, right) || projectionPathCovers(right, left);
  const contract: CallableBorrowContract = {
    parameters: signature.parameters.map((parameter) => {
      const reference = typeCanCarryReference(parameter.type, typing);
      const sourceOrigins = referenceOriginsInType(parameter.type, typing);
      const retainablePaths = retainableReferencePathsInType(
        parameter.type,
        typing,
      );
      const access =
        parameter.bindingKind === "mutable-ref"
          ? "mutable"
          : reference
            ? "shared"
            : "owned";
      const returnedOrigins =
        reference && returnsReference
          ? sourceOrigins.flatMap((source) => {
              const sourceIsRetainable = retainablePaths.some((path) =>
                pathOverlaps(path, source.path),
              );
              return resultOrigins
                .filter(
                  (result) =>
                    sourceIsRetainable ||
                    borrowedResultPaths.some((path) =>
                      pathOverlaps(path, result.path),
                    ),
                )
                .map((result) => ({
                  source: source.path,
                  result: result.path,
                  endpointAccess: source.endpointAccess,
                }));
            })
          : [];
      const retainedPaths = reference && mayRetain ? retainablePaths : [];
      return {
        access,
        ...(access === "shared" ? { readPaths: [[]] } : {}),
        ...(access === "mutable" ? { writePaths: [[]] } : {}),
        retained: retainedPaths.length > 0,
        ...(retainedPaths.length > 0 ? { retainedPaths } : {}),
        returned: returnedOrigins.length > 0,
        ...(returnedOrigins.length > 0 ? { returnedOrigins } : {}),
        ...(retainedPaths.length > 0
          ? { externalRetainedPaths: retainedPaths }
          : {}),
      };
    }),
    maySuspend: !typing.effects.isEmpty(signature.effectRow),
    ...(resultOrigins.length > 0
      ? {
          externalReturnedOrigins: resultOrigins.map((result) => ({
            result: result.path,
            endpointAccess: result.endpointAccess,
          })),
        }
      : {}),
  };
  cache.set(key, contract);
  return contract;
};

const opaqueCallableFor = (
  expr: HirExpression,
  ctx: ResolveContext,
): {
  signature?: BorrowCallSignature;
  contract?: CallableBorrowContract;
} => {
  if (expr.exprKind !== "call") {
    return {};
  }
  const callee = ctx.hir.expressions.get(expr.callee);
  if (callee?.exprKind === "identifier") {
    const metadata = ctx.symbolTable.getSymbol(callee.symbol).metadata as
      | { intrinsic?: boolean }
      | undefined;
    if (metadata?.intrinsic === true) {
      return {};
    }
  }
  const typeId = resolvedTypeFor(
    expr.callee,
    ctx.typing,
    ctx.borrowIndexMode === "symbolic",
  );
  if (typeof typeId !== "number") {
    return {};
  }
  const descriptor = ctx.typing.arena.get(typeId);
  if (descriptor.kind !== "function") {
    return {};
  }
  const signature: BorrowCallSignature = {
    parameters: descriptor.parameters,
    returnType: descriptor.returnType,
    effectRow: descriptor.effectRow,
  };
  return {
    signature,
    contract: conservativeContractFor(signature, ctx.typing, true),
  };
};

const isIntrinsicCall = (expr: HirExpression, ctx: ResolveContext): boolean => {
  if (expr.exprKind !== "call") {
    return false;
  }
  const callee = ctx.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return false;
  }
  return (
    (
      ctx.symbolTable.getSymbol(callee.symbol).metadata as
        | { intrinsic?: boolean }
        | undefined
    )?.intrinsic === true && !ctx.decls.getEffectOperation(callee.symbol)
  );
};

const intrinsicNameForCall = (
  expr: HirExpression,
  ctx: ResolveContext,
): string | undefined => {
  if (expr.exprKind !== "call") {
    return undefined;
  }
  const callee = ctx.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return undefined;
  }
  const record = ctx.symbolTable.getSymbol(callee.symbol);
  const metadata = record.metadata as
    | { intrinsic?: boolean; intrinsicName?: string }
    | undefined;
  return metadata?.intrinsic === true &&
    !ctx.decls.getEffectOperation(callee.symbol)
    ? (metadata.intrinsicName ?? record.name)
    : undefined;
};

export type ResolveContext = {
  hir: HirGraph;
  symbolTable: SymbolTable;
  decls: DeclTable;
  typing: TypingResult;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  contracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  bindingInitializers: ReadonlyMap<SymbolId, HirExprId>;
  callResolutionCache?: Map<HirExprId, ResolvedBorrowCall>;
  borrowIndexMode?: "concrete" | "symbolic";
};

const isExplicitMutableBorrow = (
  exprId: HirExprId,
  ctx: ResolveContext,
): boolean => {
  const expr = ctx.hir.expressions.get(exprId);
  if (expr?.exprKind !== "call") {
    return false;
  }
  const callee = ctx.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return false;
  }
  const record = ctx.symbolTable.getSymbol(callee.symbol);
  const metadata = record.metadata as
    | { intrinsic?: boolean; intrinsicName?: string }
    | undefined;
  return (
    metadata?.intrinsic === true &&
    (metadata.intrinsicName ?? record.name) === "~"
  );
};

const targetMaySuspend = (target: SymbolRef, ctx: ResolveContext): boolean => {
  if (target.moduleId === ctx.moduleId) {
    return (
      ctx.decls.getEffectOperation(target.symbol)?.operation.resumable ===
      "resume"
    );
  }
  return (
    ctx.dependencies.get(target.moduleId)?.effectOperations.get(target.symbol)
      ?.maySuspend === true
  );
};

const targetIsEffectOperation = (
  target: SymbolRef,
  ctx: ResolveContext,
): boolean =>
  target.moduleId === ctx.moduleId
    ? ctx.decls.getEffectOperation(target.symbol) !== undefined
    : ctx.dependencies
        .get(target.moduleId)
        ?.effectOperations.has(target.symbol) === true;

const conservativeContractForArguments = (
  expr: HirExpression,
  targets: readonly SymbolRef[],
  ctx: ResolveContext,
  mayRetain = expr.exprKind === "call" && targets.length === 0,
): CallableBorrowContract => {
  const actuals = bindCallArgumentExpressions({
    expression: expr,
    callerModuleId: ctx.moduleId,
    hir: ctx.hir,
  });
  const preferSymbolic = ctx.borrowIndexMode === "symbolic";
  const resultType = resolvedTypeFor(expr.id, ctx.typing, preferSymbolic);
  const returnsReference =
    typeof resultType !== "number" ||
    typeCanCarryReference(resultType, ctx.typing);
  const resultOrigins =
    typeof resultType === "number" && returnsReference
      ? referenceOriginsInType(resultType, ctx.typing)
      : [];
  return {
    parameters: actuals.map((actual) => {
      if (typeof actual !== "number") {
        return {
          access: "shared",
          readPaths: [[]],
          retained: mayRetain,
          returned: returnsReference,
          ...(mayRetain ? { externalRetainedPaths: [[]] } : {}),
        };
      }
      const type = resolvedTypeFor(actual, ctx.typing, preferSymbolic);
      const reference =
        typeof type !== "number" || typeCanCarryReference(type, ctx.typing);
      const access = isExplicitMutableBorrow(actual, ctx)
        ? "mutable"
        : reference
          ? "shared"
          : "owned";
      return {
        access,
        ...(access === "shared" ? { readPaths: [[]] } : {}),
        ...(access === "mutable" ? { writePaths: [[]] } : {}),
        retained: reference && mayRetain,
        returned: reference && returnsReference,
        ...(typeof type === "number" && reference && resultOrigins.length > 0
          ? {
              returnedOrigins: referenceOriginsInType(type, ctx.typing).flatMap(
                (source) =>
                  resultOrigins.map((result) => ({
                    source: source.path,
                    result: result.path,
                    endpointAccess: source.endpointAccess,
                  })),
              ),
            }
          : {}),
        ...(reference && mayRetain ? { externalRetainedPaths: [[]] } : {}),
      };
    }),
    maySuspend: targets.some((target) => targetMaySuspend(target, ctx)),
  };
};

const RETAINING_INTRINSICS = new Set([
  "__retain_callback",
  "__boundary_retain_callback",
  "__render_retain_callback",
  "__task_spawn",
  "__task_detach",
]);

const fieldPath = (name: string): readonly PlaceProjection[] => [
  { kind: "field", name },
];

const sharedCellStatePath = (): readonly PlaceProjection[] => [
  { kind: "field", name: "__borrow_state" },
  { kind: "dereference" },
  { kind: "index", constant: 0, stable: true },
];

const dynamicIndexPath = (): readonly PlaceProjection[] => [
  { kind: "dereference" },
  { kind: "index", stable: false },
];

const intrinsicBorrowContract = ({
  name,
  argumentCount,
  returnsReference,
  indexConstant,
}: {
  name: string;
  argumentCount: number;
  returnsReference: boolean;
  indexConstant?: number;
}): CallableBorrowContract | undefined => {
  if (RETAINING_INTRINSICS.has(name) && argumentCount === 1) {
    return {
      parameters: [
        {
          access: "shared",
          readPaths: [],
          retained: true,
          returned: false,
          externalRetainedPaths: [[]],
        },
      ],
      maySuspend: false,
    };
  }
  if (name === "__array_new" && returnsReference) {
    return {
      parameters: Array.from({ length: argumentCount }, () => ({
        access: "owned",
        retained: false,
        returned: false,
      })),
      maySuspend: false,
      borrowedResult: "none",
      externalReturnedOrigins: [
        {
          result: [],
          endpointAccess: "dereferenced",
          fresh: true,
        },
      ],
    };
  }
  if (name === "__array_new_fixed" && returnsReference) {
    return {
      parameters: Array.from({ length: argumentCount }, (_entry, index) => {
        const origin = {
          source: [],
          result: [
            { kind: "dereference" as const },
            {
              kind: "index" as const,
              constant: index,
              stable: true,
            },
          ],
        };
        return {
          access: "shared",
          readPaths: [],
          retained: false,
          returned: true,
          returnedOrigins: [origin],
        };
      }),
      maySuspend: false,
    };
  }
  if (name === "__array_get" && argumentCount === 2) {
    const sourceIndex = {
      kind: "index" as const,
      ...(indexConstant === undefined ? {} : { constant: indexConstant }),
      stable: indexConstant !== undefined,
    };
    const sourcePath = [{ kind: "dereference" as const }, sourceIndex];
    return {
      parameters: Array.from({ length: argumentCount }, (_entry, index) => ({
        access: index === 0 ? "shared" : "owned",
        ...(index === 0 ? { readPaths: [sourcePath] } : {}),
        retained: false,
        returned: index === 0 && returnsReference,
        ...(index === 0 && returnsReference
          ? {
              returnedOrigins: [
                {
                  source: sourcePath,
                  result: [],
                },
              ],
            }
          : {}),
      })),
      maySuspend: false,
    };
  }
  if (name === "__array_len" && argumentCount === 1) {
    return {
      parameters: [
        {
          access: "shared",
          readPaths: [[{ kind: "identity" }]],
          retained: false,
          returned: false,
        },
      ],
      maySuspend: false,
    };
  }
  if (name === "__ref_is_null" && argumentCount === 1) {
    return {
      parameters: [
        {
          access: "shared",
          readPaths: [[{ kind: "identity" }]],
          retained: false,
          returned: false,
        },
      ],
      maySuspend: false,
    };
  }
  if (name === "__array_copy" && argumentCount === 2) {
    return {
      parameters: Array.from({ length: argumentCount }, (_entry, index) => ({
        access: "shared",
        readPaths:
          index === 0
            ? [dynamicIndexPath()]
            : [[{ kind: "field", name: "from" }, ...dynamicIndexPath()]],
        retained: false,
        returned: index === 0,
      })),
      transfers: [
        {
          sourceParameter: 1,
          destinationParameter: 0,
          sourcePath: [
            { kind: "field", name: "from" },
            { kind: "dereference" },
            { kind: "index", stable: false },
          ],
          destinationPath: dynamicIndexPath(),
        },
      ],
      maySuspend: false,
    };
  }
  if (name === "__array_copy" && argumentCount === 5) {
    return {
      parameters: Array.from({ length: argumentCount }, (_entry, index) => ({
        access: index === 0 || index === 2 ? "shared" : "owned",
        ...(index === 0 || index === 2
          ? { readPaths: [dynamicIndexPath()] }
          : {}),
        retained: false,
        returned: index === 0,
      })),
      transfers: [
        {
          sourceParameter: 2,
          destinationParameter: 0,
          sourcePath: dynamicIndexPath(),
          destinationPath: dynamicIndexPath(),
        },
      ],
      maySuspend: false,
    };
  }
  if (
    (name === "__shared_cell_begin_read" ||
      name === "__shared_cell_begin_write" ||
      name === "__shared_cell_end_read" ||
      name === "__shared_cell_end_write") &&
    argumentCount === 1
  ) {
    const statePath = sharedCellStatePath();
    return {
      parameters: [
        {
          access: "shared",
          ...(name === "__shared_cell_end_write"
            ? {}
            : { readPaths: [statePath] }),
          writePaths: [statePath],
          runtimeCheckedWrites: true,
          retained: false,
          returned: false,
        },
      ],
      maySuspend: false,
    };
  }
  if (name === "__shared_cell_value" && argumentCount === 1) {
    const valuePath = fieldPath("__value");
    return {
      parameters: [
        {
          access: "shared",
          readPaths: [valuePath],
          retained: false,
          returned: returnsReference,
          ...(returnsReference
            ? {
                returnedOrigins: [{ source: valuePath, result: [] }],
              }
            : {}),
        },
      ],
      maySuspend: false,
    };
  }
  if (name === "__shared_cell_set_value" && argumentCount === 2) {
    return {
      parameters: [
        {
          access: "shared",
          writePaths: [fieldPath("__value")],
          runtimeCheckedWrites: true,
          retained: false,
          returned: false,
        },
        {
          access: "shared",
          readPaths: [],
          retained: false,
          returned: false,
        },
      ],
      transfers: [
        {
          sourceParameter: 1,
          destinationParameter: 0,
          destinationPath: fieldPath("__value"),
        },
      ],
      maySuspend: false,
    };
  }
  if (
    (name === "__boundary_value_to_msgpack" ||
      name === "__boundary_msgpack_to_value") &&
    argumentCount === 1
  ) {
    const identityOrigin = { source: [], result: [] };
    const conditionId = borrowTypeConditionId({
      parameter: 0,
      sourcePath: [],
      resultPath: [],
    });
    return {
      parameters: [
        {
          access: "shared",
          readPaths: [[]],
          accessIfResultTypeDiffers: {
            conditionId,
            parameter: 0,
            sourcePath: [],
            resultPath: [],
          },
          retained: false,
          returned: returnsReference,
          ...(returnsReference
            ? {
                returnedOrigins: [identityOrigin],
                returnedTypeMatchingOrigins: [
                  { ...identityOrigin, conditionId },
                ],
              }
            : {}),
        },
      ],
      maySuspend: false,
    };
  }
  if (
    name === "__boundary_msgpack_to_value_or_identity" &&
    argumentCount === 2
  ) {
    const identityOrigin = { source: [], result: [] };
    const conditionId = borrowTypeConditionId({
      parameter: 0,
      sourcePath: [],
      resultPath: [],
    });
    return {
      parameters: [
        {
          access: "shared",
          readPaths: [],
          retained: false,
          returned: returnsReference,
          ...(returnsReference
            ? {
                returnedOrigins: [identityOrigin],
                returnedTypeMatchingOrigins: [
                  { ...identityOrigin, conditionId },
                ],
              }
            : {}),
        },
        {
          access: "shared",
          readPaths: [[]],
          accessIfResultTypeDiffers: {
            conditionId,
            parameter: 0,
            sourcePath: [],
            resultPath: [],
          },
          retained: false,
          returned: false,
        },
      ],
      maySuspend: false,
    };
  }
  const storedValueIndex = name === "__array_set" ? 2 : undefined;
  if (typeof storedValueIndex !== "number") {
    return undefined;
  }
  return {
    parameters: Array.from({ length: argumentCount }, (_entry, index) => ({
      access: index === 0 || index === storedValueIndex ? "shared" : "owned",
      ...(index === 0
        ? {
            writePaths: [dynamicIndexPath()],
          }
        : index === storedValueIndex
          ? { readPaths: [] }
          : {}),
      retained: false,
      returned: index === 0,
    })),
    transfers: [
      {
        sourceParameter: storedValueIndex,
        destinationParameter: 0,
        destinationPath: dynamicIndexPath(),
      },
    ],
    maySuspend: false,
  };
};

const numericConstant = (
  exprId: HirExprId | undefined,
  hir: HirGraph,
): number | undefined => {
  if (typeof exprId !== "number") {
    return undefined;
  }
  const expr = hir.expressions.get(exprId);
  if (expr?.exprKind !== "literal" || expr.literalKind !== "i32") {
    return undefined;
  }
  const value = Number(expr.value);
  return Number.isInteger(value) ? value : undefined;
};

const uniqueTargets = (
  exprId: HirExprId,
  typing: TypingResult,
  preferSymbolic: boolean,
): readonly SymbolRef[] => {
  const concrete = [...(typing.callTargets.get(exprId)?.values() ?? [])];
  const symbolic = [...(typing.borrowCallTargets.get(exprId)?.values() ?? [])];
  const targets = preferSymbolic
    ? [...symbolic, ...concrete]
    : concrete.length > 0
      ? concrete
      : symbolic;
  if (targets.length === 0) {
    return [];
  }
  return Array.from(
    new Map<string, SymbolRef>(
      targets.map((target) => [`${target.moduleId}:${target.symbol}`, target]),
    ).values(),
  );
};

export const expressionTypeFor = (
  exprId: HirExprId,
  ctx: ResolveContext,
  seen = new Set<HirExprId>(),
): number | undefined => {
  const cached = resolvedTypeFor(
    exprId,
    ctx.typing,
    ctx.borrowIndexMode === "symbolic",
  );
  if (typeof cached === "number" || seen.has(exprId)) {
    return cached;
  }
  seen.add(exprId);
  const expression = ctx.hir.expressions.get(exprId);
  if (expression?.exprKind === "identifier") {
    const valueType = ctx.typing.valueTypes.get(expression.symbol);
    if (typeof valueType === "number") {
      return valueType;
    }
    const initializer = ctx.bindingInitializers.get(expression.symbol);
    if (typeof initializer === "number") {
      const initializerType = expressionTypeFor(initializer, ctx, seen);
      if (typeof initializerType === "number") {
        return initializerType;
      }
    }
    for (const [, signature] of ctx.typing.functions.signatures) {
      const parameter = signature.parameters.find(
        (candidate) => candidate.symbol === expression.symbol,
      );
      if (parameter) {
        return parameter.type;
      }
    }
    return undefined;
  }
  if (expression?.exprKind === "call") {
    const callee = ctx.hir.expressions.get(expression.callee);
    if (callee?.exprKind !== "identifier") {
      return undefined;
    }
    const imported = ctx.imports.get(callee.symbol);
    return imported
      ? ctx.dependencies.get(imported.moduleId)?.callables.get(imported.symbol)
          ?.signature?.returnType
      : ctx.typing.functions.getSignature(callee.symbol)?.returnType;
  }
  return undefined;
};

const expressionCanCarryReference = (
  exprId: HirExprId,
  ctx: ResolveContext,
): boolean => {
  const type = expressionTypeFor(exprId, ctx);
  return typeof type !== "number" || typeCanCarryReference(type, ctx.typing);
};

const projectedTypesCache = new WeakMap<
  TypingResult,
  Map<TypeId, Map<string, readonly TypeId[]>>
>();
const projectedTypeFieldsCache = new WeakMap<
  TypingResult,
  Map<
    TypeId,
    {
      byName: ReadonlyMap<string, TypeId>;
      byIndex: readonly TypeId[];
    }
  >
>();

const projectionPathKey = (projections: readonly PlaceProjection[]): string =>
  projections
    .map((projection) => {
      switch (projection.kind) {
        case "field":
          return `f${projection.name.length}:${projection.name}`;
        case "tuple":
          return `t${projection.index}`;
        case "index":
          return `i${projection.stable ? 1 : 0}:${projection.constant ?? ""}`;
        case "region":
          return `r${projection.scope.length}:${projection.scope}:${projection.name.length}:${projection.name}:${projection.disjoint.join(",")}`;
        case "discriminant":
          return "c";
        case "dereference":
          return "d";
        case "identity":
          return "y";
      }
    })
    .join("/");

const projectedTypeFields = (
  type: TypeId,
  typing: TypingResult,
):
  | {
      byName: ReadonlyMap<string, TypeId>;
      byIndex: readonly TypeId[];
    }
  | undefined => {
  let fieldsByType = projectedTypeFieldsCache.get(typing);
  if (!fieldsByType) {
    fieldsByType = new Map();
    projectedTypeFieldsCache.set(typing, fieldsByType);
  }
  const cached = fieldsByType.get(type);
  if (cached) {
    return cached;
  }
  const descriptor = typing.arena.get(type);
  const fields =
    descriptor.kind === "structural-object"
      ? descriptor.fields
      : descriptor.kind === "nominal-object" ||
          descriptor.kind === "value-object"
        ? typing.objectsByNominal.get(type)?.fields
        : undefined;
  if (!fields) {
    return undefined;
  }
  const indexed = {
    byName: new Map(fields.map((field) => [field.name, field.type])),
    byIndex: fields.map((field) => field.type),
  };
  fieldsByType.set(type, indexed);
  return indexed;
};

export const projectedTypes = (
  type: TypeId,
  projections: readonly PlaceProjection[],
  typing: TypingResult,
): readonly TypeId[] => {
  let cacheByType = projectedTypesCache.get(typing);
  if (!cacheByType) {
    cacheByType = new Map();
    projectedTypesCache.set(typing, cacheByType);
  }
  let cacheByPath = cacheByType.get(type);
  if (!cacheByPath) {
    cacheByPath = new Map();
    cacheByType.set(type, cacheByPath);
  }
  const pathKey = projectionPathKey(projections);
  const cached = cacheByPath.get(pathKey);
  if (cached) {
    return cached;
  }
  const result = resolveProjectedTypes(
    type,
    projections,
    typing,
    new Set<TypeId>(),
  );
  cacheByPath.set(pathKey, result);
  return result;
};

const resolveProjectedTypes = (
  type: TypeId,
  projections: readonly PlaceProjection[],
  typing: TypingResult,
  active: Set<TypeId>,
): readonly TypeId[] => {
  if (projections.length === 0 || active.has(type)) {
    return projections.length === 0 ? [type] : [];
  }
  active.add(type);
  const descriptor = typing.arena.get(type);
  const [projection, ...remaining] = projections;
  if (projection?.kind === "dereference") {
    return resolveProjectedTypes(type, remaining, typing, new Set<TypeId>());
  }
  const candidates = (() => {
    if (descriptor.kind === "borrowed") {
      return resolveProjectedTypes(
        descriptor.inner,
        projections,
        typing,
        active,
      );
    }
    if (descriptor.kind === "recursive") {
      return resolveProjectedTypes(
        descriptor.body,
        projections,
        typing,
        active,
      );
    }
    if (descriptor.kind === "union") {
      return descriptor.members.flatMap((member) =>
        resolveProjectedTypes(member, projections, typing, new Set(active)),
      );
    }
    if (descriptor.kind === "intersection") {
      return [descriptor.nominal, descriptor.structural].flatMap((member) =>
        typeof member === "number"
          ? resolveProjectedTypes(member, projections, typing, new Set(active))
          : [],
      );
    }
    if (projection?.kind === "index" && descriptor.kind === "fixed-array") {
      return resolveProjectedTypes(
        descriptor.element,
        remaining,
        typing,
        active,
      );
    }
    const fields = projectedTypeFields(type, typing);
    const fieldType =
      projection?.kind === "field"
        ? fields?.byName.get(projection.name)
        : projection?.kind === "tuple"
          ? fields?.byIndex[projection.index]
          : undefined;
    return typeof fieldType === "number"
      ? resolveProjectedTypes(fieldType, remaining, typing, active)
      : [];
  })();
  active.delete(type);
  return candidates;
};

export const materializedObjectReferencePaths = (
  type: TypeId,
  typing: TypingResult,
  prefix: readonly PlaceProjection[] = [],
  expandNominalObject = true,
  active = new Set<TypeId>(),
): readonly (readonly PlaceProjection[])[] => {
  if (active.has(type)) {
    return [];
  }
  active.add(type);
  const descriptor = typing.arena.get(type);
  const paths = (() => {
    if (descriptor.kind === "borrowed") {
      return [prefix];
    }
    if (descriptor.kind === "recursive") {
      return materializedObjectReferencePaths(
        descriptor.body,
        typing,
        prefix,
        expandNominalObject,
        active,
      );
    }
    if (descriptor.kind === "union") {
      return descriptor.members.flatMap((member) =>
        materializedObjectReferencePaths(
          member,
          typing,
          prefix,
          false,
          new Set(active),
        ),
      );
    }
    if (descriptor.kind === "intersection") {
      if (typeof descriptor.nominal === "number") {
        return materializedObjectReferencePaths(
          descriptor.nominal,
          typing,
          prefix,
          expandNominalObject,
          new Set(active),
        );
      }
      if (typeof descriptor.structural === "number") {
        return materializedObjectReferencePaths(
          descriptor.structural,
          typing,
          prefix,
          expandNominalObject,
          new Set(active),
        );
      }
      return (descriptor.traits?.length ?? 0) > 0 ? [prefix] : [];
    }
    if (descriptor.kind === "nominal-object" && !expandNominalObject) {
      return [prefix];
    }
    const fields =
      descriptor.kind === "structural-object"
        ? descriptor.fields
        : descriptor.kind === "nominal-object" ||
            descriptor.kind === "value-object"
          ? typing.objectsByNominal.get(type)?.fields
          : undefined;
    if (fields) {
      return fields.flatMap((field) =>
        materializedObjectReferencePaths(
          field.type,
          typing,
          [...prefix, { kind: "field", name: field.name }],
          false,
          new Set(active),
        ),
      );
    }
    return descriptor.kind === "primitive" ? [] : [prefix];
  })();
  active.delete(type);
  return Array.from(
    new Map(paths.map((path) => [JSON.stringify(path), path])).values(),
  );
};

const projectionCanCarryReference = (
  type: TypeId,
  projections: readonly PlaceProjection[],
  typing: TypingResult,
): boolean => {
  const types = projectedTypes(type, projections, typing);
  return (
    types.length === 0 ||
    types.some((projected) => typeCanCarryReference(projected, typing))
  );
};

const specializeConditionalContract = (
  contract: CallableBorrowContract,
  expr: HirExpression,
  arguments_: readonly (HirExprId | undefined)[],
  ctx: ResolveContext,
): CallableBorrowContract => {
  if (ctx.borrowIndexMode === "symbolic") {
    return contract;
  }
  const resultType = resolvedTypeFor(expr.id, ctx.typing);
  const matchesResult = ({
    parameter,
    sourcePath,
    resultPath,
  }: {
    parameter: number;
    sourcePath: readonly PlaceProjection[];
    resultPath: readonly PlaceProjection[];
  }): boolean | undefined => {
    const actual = arguments_[parameter];
    if (typeof actual !== "number" || typeof resultType !== "number") {
      return undefined;
    }
    const actualType = resolvedTypeFor(actual, ctx.typing);
    if (typeof actualType !== "number") {
      return undefined;
    }
    const sourceTypes = projectedTypes(actualType, sourcePath, ctx.typing);
    const resultTypes = projectedTypes(resultType, resultPath, ctx.typing);
    return sourceTypes.length > 0 && resultTypes.length > 0
      ? sourceTypes.some((source) => resultTypes.includes(source))
      : undefined;
  };
  return {
    ...contract,
    parameters: contract.parameters.map((parameter, index) => {
      const returnedOriginKey = (origin: ReturnedBorrowOrigin): string =>
        JSON.stringify([
          origin.source,
          origin.result,
          origin.endpointAccess ?? null,
        ]);
      const conditionalOrigins = new Map(
        (parameter.returnedTypeMatchingOrigins ?? []).map((origin) => [
          returnedOriginKey(origin),
          origin,
        ]),
      );
      const returnedOrigins = parameter.returnedOrigins?.filter((origin) => {
        if (!conditionalOrigins.has(returnedOriginKey(origin))) {
          return true;
        }
        return (
          matchesResult({
            parameter: index,
            sourcePath: origin.source,
            resultPath: origin.result,
          }) !== false
        );
      });
      const unresolvedConditionalOrigins =
        returnedOrigins?.flatMap((origin) => {
          const condition = conditionalOrigins.get(returnedOriginKey(origin));
          if (!condition) {
            return [];
          }
          return matchesResult({
            parameter: index,
            sourcePath: origin.source,
            resultPath: origin.result,
          }) === undefined
            ? [condition]
            : [];
        }) ?? [];
      const accessMatch = parameter.accessIfResultTypeDiffers
        ? matchesResult(parameter.accessIfResultTypeDiffers)
        : undefined;
      const {
        returnedOrigins: _returnedOrigins,
        returnedTypeMatchingOrigins: _returnedConditions,
        accessIfResultTypeDiffers: _accessCondition,
        ...rest
      } = parameter;
      const returned =
        parameter.returnedOrigins === undefined
          ? parameter.returned
          : (returnedOrigins?.length ?? 0) > 0;
      return {
        ...rest,
        returned,
        ...(returnedOrigins?.length ? { returnedOrigins } : {}),
        ...(unresolvedConditionalOrigins.length
          ? { returnedTypeMatchingOrigins: unresolvedConditionalOrigins }
          : {}),
        ...(accessMatch === true ? { readPaths: [], writePaths: [] } : {}),
        ...(accessMatch === undefined && parameter.accessIfResultTypeDiffers
          ? { accessIfResultTypeDiffers: parameter.accessIfResultTypeDiffers }
          : {}),
      };
    }),
  };
};

const filterConcreteProvenance = (
  contract: CallableBorrowContract,
  resultType: TypeId | undefined,
  arguments_: readonly (HirExprId | undefined)[],
  ctx: ResolveContext,
): CallableBorrowContract => {
  const parameters = contract.parameters.map((parameter, index) => {
    const actual = arguments_[index];
    const actualType =
      typeof actual === "number" ? expressionTypeFor(actual, ctx) : undefined;
    const suppressBorrowRetention =
      parameter.retainedUnlessBorrowed === true &&
      typeof actualType === "number" &&
      typeContainsBorrowed(actualType, ctx.typing);
    const filterPaths = (
      paths: readonly (readonly PlaceProjection[])[],
    ): readonly (readonly PlaceProjection[])[] =>
      typeof actualType !== "number"
        ? paths
        : paths.filter((path) =>
            projectionCanCarryReference(actualType, path, ctx.typing),
          );
    const declaredRetainedPaths = parameter.retainedPaths?.length
      ? parameter.retainedPaths
      : [[]];
    const concretelyRetainablePaths =
      suppressBorrowRetention && typeof actualType === "number"
        ? retainableReferencePathsInType(actualType, ctx.typing).filter(
            (candidate) =>
              declaredRetainedPaths.some(
                (declared) =>
                  projectionPathCovers(declared, candidate) ||
                  projectionPathCovers(candidate, declared),
              ),
          )
        : declaredRetainedPaths;
    const retainedPaths = parameter.retained
      ? filterPaths(concretelyRetainablePaths)
      : [];
    const externalRetainedPaths = parameter.externalRetainedPaths
      ? filterPaths(
          suppressBorrowRetention
            ? concretelyRetainablePaths
            : parameter.externalRetainedPaths,
        )
      : [];
    const borrowedRetainedPaths = suppressBorrowRetention
      ? []
      : filterPaths(parameter.borrowedRetainedPaths ?? []);
    const returnedOrigins = parameter.returnedOrigins?.filter((origin) => {
      return (
        typeof resultType !== "number" ||
        projectionCanCarryReference(resultType, origin.result, ctx.typing)
      );
    });
    const retainsBroadReturn =
      parameter.returned &&
      !parameter.returnedOrigins &&
      (typeof resultType !== "number" ||
        typeCanCarryReference(resultType, ctx.typing));
    const returned = retainsBroadReturn || (returnedOrigins?.length ?? 0) > 0;
    const {
      retainedPaths: _retainedPaths,
      externalRetainedPaths: _externalRetainedPaths,
      borrowedRetainedPaths: _borrowedRetainedPaths,
      returnedPaths: _returnedPaths,
      returnedOrigins: _returnedOrigins,
      returnedSharedOrigins: _returnedSharedOrigins,
      returnedTypeMatchingOrigins: _returnedConditions,
      ...rest
    } = parameter;
    const retained = retainedPaths.length > 0;
    const retainedProperties = retained
      ? parameter.retainedPaths
        ? { retainedPaths }
        : {}
      : {};
    const borrowedRetainedProperties =
      borrowedRetainedPaths.length > 0 ? { borrowedRetainedPaths } : {};
    const externalRetainedProperties =
      externalRetainedPaths.length > 0 ? { externalRetainedPaths } : {};
    if (returned) {
      const matchesReturned = (origin: ReturnedBorrowOrigin): boolean =>
        returnedOrigins?.some(
          (candidate) =>
            JSON.stringify(candidate.source) ===
              JSON.stringify(origin.source) &&
            projectionPathCovers(candidate.result, origin.result) &&
            (candidate.endpointAccess ?? "inline") ===
              (origin.endpointAccess ?? "inline"),
        ) ?? false;
      return {
        ...rest,
        retained,
        returned: true,
        ...retainedProperties,
        ...externalRetainedProperties,
        ...borrowedRetainedProperties,
        ...(parameter.returnedPaths
          ? { returnedPaths: parameter.returnedPaths }
          : {}),
        ...(returnedOrigins ? { returnedOrigins } : {}),
        ...(parameter.returnedSharedOrigins
          ? {
              returnedSharedOrigins:
                parameter.returnedSharedOrigins.filter(matchesReturned),
            }
          : {}),
        ...(parameter.returnedTypeMatchingOrigins
          ? {
              returnedTypeMatchingOrigins:
                parameter.returnedTypeMatchingOrigins.filter(matchesReturned),
            }
          : {}),
      };
    }
    return {
      ...rest,
      retained,
      returned: false,
      ...retainedProperties,
      ...externalRetainedProperties,
      ...borrowedRetainedProperties,
    };
  });
  const transfers = contract.transfers?.filter((transfer) => {
    const source = arguments_[transfer.sourceParameter];
    if (typeof source !== "number") {
      return true;
    }
    const sourceType = expressionTypeFor(source, ctx);
    return (
      typeof sourceType !== "number" ||
      projectionCanCarryReference(
        sourceType,
        transfer.sourcePath ?? [],
        ctx.typing,
      )
    );
  });
  return {
    ...contract,
    parameters,
    ...(contract.transfers
      ? { transfers: transfers?.length ? transfers : undefined }
      : {}),
  };
};

const directTarget = (
  expr: HirExpression,
  ctx: ResolveContext,
): SymbolRef | undefined => {
  if (expr.exprKind !== "call") {
    return undefined;
  }
  const callee = ctx.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return undefined;
  }
  const imported = ctx.imports.get(callee.symbol);
  if (imported) {
    return imported;
  }
  return ctx.typing.functions.getSignature(callee.symbol)
    ? {
        moduleId: ctx.moduleId,
        symbol: callee.symbol,
      }
    : undefined;
};

const traitDefaultCallTargets = new WeakMap<
  HirGraph,
  ReadonlyMap<HirExprId, readonly SymbolRef[]>
>();

const traitDefaultTargetsFor = (
  expr: HirExpression,
  ctx: ResolveContext,
): readonly SymbolRef[] => {
  if (expr.exprKind !== "method-call") {
    return [];
  }
  let byExpression = traitDefaultCallTargets.get(ctx.hir);
  if (!byExpression) {
    const mutable = new Map<HirExprId, readonly SymbolRef[]>();
    Array.from(ctx.hir.items.values()).forEach((item) => {
      if (item.kind !== "trait") {
        return;
      }
      const methodsByName = new Map<string, SymbolRef[]>();
      item.methods.forEach((method) => {
        const name = ctx.symbolTable.getSymbol(method.symbol).name;
        const targets = methodsByName.get(name) ?? [];
        targets.push({ moduleId: ctx.moduleId, symbol: method.symbol });
        methodsByName.set(name, targets);
      });
      item.methods.forEach((method) => {
        if (typeof method.defaultBody !== "number") {
          return;
        }
        walkExpression({
          exprId: method.defaultBody,
          hir: ctx.hir,
          onEnterExpression: (exprId, expression) => {
            if (expression.exprKind !== "method-call") {
              return;
            }
            const targets = methodsByName.get(expression.method);
            if (targets) {
              mutable.set(exprId, targets);
            }
          },
        });
      });
    });
    byExpression = mutable;
    traitDefaultCallTargets.set(ctx.hir, byExpression);
  }
  return byExpression.get(expr.id) ?? [];
};

const borrowCallTargets = (
  expr: HirExpression,
  ctx: ResolveContext,
): {
  targets: readonly SymbolRef[];
  direct?: SymbolRef;
  openTraitDispatch?: true;
} => {
  const resolved = uniqueTargets(
    expr.id,
    ctx.typing,
    ctx.borrowIndexMode === "symbolic",
  );
  if (resolved.length > 0) {
    return { targets: resolved };
  }
  const traitTargets = traitDefaultTargetsFor(expr, ctx);
  if (traitTargets.length > 0) {
    return { targets: traitTargets, openTraitDispatch: true };
  }
  const direct = directTarget(expr, ctx);
  return {
    targets: direct ? [direct] : [],
    ...(direct ? { direct } : {}),
  };
};

export const callHasIntrinsicBorrowBoundary = (
  expr: HirExpression,
  ctx: ResolveContext,
): boolean => {
  if (!isIntrinsicCall(expr, ctx)) return false;
  return borrowCallTargets(expr, ctx).targets.every((target) => {
    if (target.moduleId !== ctx.moduleId) return false;
    const metadata = ctx.symbolTable.getSymbol(target.symbol).metadata as
      | { intrinsic?: boolean }
      | undefined;
    return metadata?.intrinsic === true;
  });
};

const selectedTraitDeclarationContracts = (
  targets: readonly SymbolRef[],
  ctx: ResolveContext,
): readonly {
  contract: CallableBorrowContract;
  source?: import("./callable-summary.js").CallableBorrowSummarySource;
}[] => {
  const contracts = new Map<
    string,
    {
      contract: CallableBorrowContract;
      source?: import("./callable-summary.js").CallableBorrowSummarySource;
    }
  >();
  targets.forEach((target) => {
    if (target.moduleId !== ctx.moduleId) {
      const dependency = ctx.dependencies.get(target.moduleId);
      const declaration = dependency?.traitMethodDeclarations.get(
        target.symbol,
      );
      const callable = declaration
        ? ctx.dependencies
            .get(declaration.moduleId)
            ?.callables.get(declaration.symbol)
        : undefined;
      const contract =
        callable?.contract ??
        dependency?.traitMethodContracts.get(target.symbol);
      if (contract) {
        contracts.set(`${target.moduleId}:${target.symbol}`, {
          contract,
          source: callable?.source,
        });
      }
      return;
    }
    const mapping = ctx.typing.traitMethodImpls.get(target.symbol);
    const metadata = mapping
      ? ((ctx.symbolTable.getSymbol(mapping.traitMethodSymbol).metadata ??
          {}) as {
          import?: { moduleId?: unknown; symbol?: unknown };
        })
      : undefined;
    const imported = metadata?.import;
    const callable =
      typeof imported?.moduleId === "string" &&
      typeof imported.symbol === "number"
        ? ctx.dependencies
            .get(imported.moduleId)
            ?.callables.get(imported.symbol)
        : undefined;
    const declaration =
      callable?.contract ??
      (mapping ? ctx.contracts.get(mapping.traitMethodSymbol) : undefined);
    const contract =
      declaration ?? ctx.contracts.get(target.symbol)?.dynamicDispatch;
    if (contract) {
      contracts.set(`${target.moduleId}:${target.symbol}`, {
        contract,
        source: callable?.source,
      });
    }
  });
  return Array.from(contracts.values());
};

const typedArgumentsFor = (
  expr: HirExpression,
  typing: TypingResult,
  hir: HirGraph,
  moduleId: string,
  preferSymbolic: boolean,
): {
  arguments?: readonly (HirExprId | undefined)[];
  ambiguous: boolean;
} => {
  const concrete = [...(typing.callArgumentPlans.get(expr.id)?.values() ?? [])];
  const symbolic = [
    ...(typing.borrowCallArgumentPlans.get(expr.id)?.values() ?? []),
  ];
  const selected = preferSymbolic
    ? [...symbolic, ...concrete]
    : concrete.length > 0
      ? concrete
      : symbolic;
  const plans = selected.map((plan) =>
    bindCallArgumentExpressions({
      expression: expr,
      plan,
      callerModuleId: moduleId,
      hir,
    }),
  );
  if (plans.length === 0) {
    return { ambiguous: false };
  }
  const first = plans[0]!;
  const firstKey = plans.length > 1 ? JSON.stringify(first) : "";
  const ambiguous =
    plans.length > 1 &&
    plans.slice(1).some((plan) => JSON.stringify(plan) !== firstKey);
  return ambiguous
    ? {
        arguments: bindCallArgumentExpressions({
          expression: expr,
          callerModuleId: moduleId,
          hir,
        }),
        ambiguous: true,
      }
    : { arguments: first, ambiguous: false };
};

const resolveBorrowCallInternal = (
  expr: HirExpression,
  ctx: ResolveContext,
  deferAvailableContracts: boolean,
): ResolvedBorrowCall => {
  const cached = ctx.callResolutionCache?.get(expr.id);
  if (cached) {
    return cached;
  }
  const preferSymbolic = ctx.borrowIndexMode === "symbolic";
  const { targets, direct, openTraitDispatch } = borrowCallTargets(expr, ctx);
  const entries = targets.map((target) => {
    if (target.moduleId === ctx.moduleId) {
      return {
        target,
        signature: ctx.typing.functions.getSignature(target.symbol),
        contract: ctx.contracts.get(target.symbol),
        dispatch: undefined,
        namedContract: undefined,
        source: undefined,
      };
    }
    const callable = ctx.dependencies
      .get(target.moduleId)
      ?.callables.get(target.symbol);
    return {
      target,
      signature: callable?.signature,
      contract: callable?.contract,
      dispatch: callable?.dispatch,
      namedContract: callable?.namedContract,
      source: callable?.source,
    };
  });
  const typedArguments = typedArgumentsFor(
    expr,
    ctx.typing,
    ctx.hir,
    ctx.moduleId,
    preferSymbolic,
  );
  const entrySignatures = entries.flatMap((entry) =>
    entry.signature ? [entry.signature] : [],
  );
  const signatureKey = (signature: BorrowCallSignature): string =>
    JSON.stringify({
      parameters: signature.parameters.map((parameter) => ({
        type: parameter.type,
        label: parameter.label,
        bindingKind: parameter.bindingKind,
      })),
      returnType: signature.returnType,
      effectRow: signature.effectRow,
    });
  const firstSignature = entrySignatures[0];
  const firstSignatureKey =
    entrySignatures.length > 1 && firstSignature
      ? signatureKey(firstSignature)
      : "";
  const signaturesAgree =
    firstSignature !== undefined &&
    (entrySignatures.length === 1 ||
      entrySignatures
        .slice(1)
        .every((candidate) => signatureKey(candidate) === firstSignatureKey));
  const opaque = signaturesAgree ? {} : opaqueCallableFor(expr, ctx);
  const signature = signaturesAgree ? firstSignature : opaque.signature;
  const traitDispatch = ctx.typing.callTraitDispatches.has(expr.id);
  const arguments_ =
    typedArguments.arguments ??
    (targets.length === 0 || direct
      ? bindCallArgumentExpressions({
          expression: expr,
          parameters: signature?.parameters,
          callerModuleId: ctx.moduleId,
          hir: ctx.hir,
        })
      : bindCallArgumentExpressions({
          expression: expr,
          callerModuleId: ctx.moduleId,
          hir: ctx.hir,
        }));
  if (
    deferAvailableContracts &&
    !typedArguments.ambiguous &&
    targets.length > 0 &&
    !traitDispatch &&
    !openTraitDispatch &&
    !isIntrinsicCall(expr, ctx) &&
    entries.every((entry) => entry.contract !== undefined)
  ) {
    return {
      target: entries.length === 1 ? entries[0]?.target : undefined,
      targets,
      signature,
      arguments: arguments_,
      contractSources: entries.flatMap((entry) =>
        entry.source ? [summarySpanToSourceSpan(entry.source.declaration)] : [],
      ),
    };
  }
  const intrinsicArguments =
    typedArguments.arguments ??
    bindCallArgumentExpressions({
      expression: expr,
      callerModuleId: ctx.moduleId,
      hir: ctx.hir,
    });
  const contracts = entries.flatMap((entry) => {
    if (entry.contract) {
      return [entry.contract];
    }
    const intrinsic =
      entry.target.moduleId === ctx.moduleId &&
      (
        ctx.symbolTable.getSymbol(entry.target.symbol).metadata as
          | { intrinsic?: boolean }
          | undefined
      )?.intrinsic === true &&
      !ctx.decls.getEffectOperation(entry.target.symbol);
    if (intrinsic) {
      const record = ctx.symbolTable.getSymbol(entry.target.symbol);
      const metadata = record.metadata as
        | { intrinsicName?: string }
        | undefined;
      const name = metadata?.intrinsicName ?? record.name;
      const contract = intrinsicBorrowContract({
        name,
        argumentCount: intrinsicArguments.length,
        returnsReference: expressionCanCarryReference(expr.id, ctx),
        indexConstant:
          name === "__array_get"
            ? numericConstant(intrinsicArguments[1], ctx.hir)
            : undefined,
      });
      if (contract) {
        return [contract];
      }
      return [];
    }
    const fallback =
      opaque.contract ??
      (entry.signature
        ? conservativeContractFor(
            entry.signature,
            ctx.typing,
            targetIsEffectOperation(entry.target, ctx),
          )
        : conservativeContractForArguments(
            expr,
            [entry.target],
            ctx,
            targetIsEffectOperation(entry.target, ctx),
          ));
    return [fallback];
  });
  const intrinsicName = intrinsicNameForCall(expr, ctx);
  const intrinsicContract =
    typeof intrinsicName === "string"
      ? intrinsicBorrowContract({
          name: intrinsicName,
          argumentCount: intrinsicArguments.length,
          returnsReference: expressionCanCarryReference(expr.id, ctx),
          indexConstant:
            intrinsicName === "__array_get"
              ? numericConstant(intrinsicArguments[1], ctx.hir)
              : undefined,
        })
      : undefined;
  const unresolvedContract =
    intrinsicContract ??
    opaque.contract ??
    (!isIntrinsicCall(expr, ctx)
      ? conservativeContractForArguments(expr, [], ctx)
      : undefined);
  const receiverDeclarations =
    ctx.typing.callTraitDispatches.has(expr.id) || openTraitDispatch
      ? selectedTraitDeclarationContracts(targets, ctx)
      : [];
  const declaredTraitContracts =
    ctx.typing.callTraitDispatches.has(expr.id) || openTraitDispatch
      ? receiverDeclarations.length > 0
        ? receiverDeclarations.map((entry) => entry.contract)
        : entries.flatMap((entry) => {
            if (openTraitDispatch && entry.contract) {
              return [entry.contract];
            }
            if (
              (entry.dispatch === "trait-declaration" ||
                entry.dispatch === "trait-implementation") &&
              entry.contract
            ) {
              return [entry.contract];
            }
            if (entry.contract?.dynamicDispatch) {
              return [entry.contract.dynamicDispatch];
            }
            if (entry.target.moduleId === ctx.moduleId) {
              const mapping = ctx.typing.traitMethodImpls.get(
                entry.target.symbol,
              );
              const declared = mapping
                ? ctx.contracts.get(mapping.traitMethodSymbol)
                : undefined;
              return declared ? [declared] : [];
            }
            return [];
          })
      : [];
  const openTraitFallback =
    (ctx.typing.callTraitDispatches.has(expr.id) || openTraitDispatch) &&
    declaredTraitContracts.length === 0 &&
    signature
      ? conservativeContractFor(signature, ctx.typing, true)
      : undefined;
  const mergedContract = intrinsicContract
    ? intrinsicContract
    : typedArguments.ambiguous
      ? conservativeContractForArguments(
          expr,
          targets,
          ctx,
          targets.some((target) => targetIsEffectOperation(target, ctx)),
        )
      : (() => {
          const availableContracts =
            declaredTraitContracts.length > 0
              ? declaredTraitContracts
              : openTraitFallback
                ? [openTraitFallback]
                : targets.length > 0
                  ? contracts
                  : unresolvedContract
                    ? [unresolvedContract]
                    : [];
          return availableContracts.length === 1
            ? availableContracts[0]
            : mergeCallableBorrowContracts(availableContracts);
        })();
  const specializedContract = mergedContract
    ? specializeConditionalContract(mergedContract, expr, arguments_, ctx)
    : undefined;
  const contract = specializedContract
    ? filterConcreteProvenance(
        specializedContract,
        expressionTypeFor(expr.id, ctx),
        arguments_,
        ctx,
      )
    : undefined;
  const result = {
    target: entries.length === 1 ? entries[0]?.target : undefined,
    targets,
    signature,
    contract,
    arguments: arguments_,
    contractSources: entries
      .flatMap((entry) =>
        entry.source ? [summarySpanToSourceSpan(entry.source.declaration)] : [],
      )
      .concat(
        receiverDeclarations.flatMap((entry) =>
          entry.source
            ? [summarySpanToSourceSpan(entry.source.declaration)]
            : [],
        ),
      ),
    ...(traitDispatch ? { traitDispatch: true as const } : {}),
    ...(openTraitDispatch ? { openTraitDispatch: true as const } : {}),
    ...(typedArguments.ambiguous
      ? { argumentPlanAmbiguous: true as const }
      : {}),
  };
  ctx.callResolutionCache?.set(expr.id, result);
  return result;
};

export const resolveBorrowCall = (
  expr: HirExpression,
  ctx: ResolveContext,
): ResolvedBorrowCall => resolveBorrowCallInternal(expr, ctx, false);

export const resolveBorrowCallForFacts = (
  expr: HirExpression,
  ctx: ResolveContext,
): ResolvedBorrowCall => resolveBorrowCallInternal(expr, ctx, true);

/** Resolve an extracted call fact against the current compact contracts. */
export const resolveBorrowCallFromFact = ({
  expr,
  fact,
  ctx,
}: {
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  fact: BorrowCallFactResolution;
  ctx: ResolveContext;
}): ResolvedBorrowCall => {
  const cached = ctx.callResolutionCache?.get(expr.id);
  if (cached) return cached;
  const currentContracts = fact.targets.flatMap((target) => {
    const contract =
      target.moduleId === ctx.moduleId
        ? ctx.contracts.get(target.symbol)
        : ctx.dependencies.get(target.moduleId)?.callables.get(target.symbol)
            ?.contract;
    return contract ? [contract] : [];
  });
  const usesExtractedBoundaryContract =
    fact.intrinsicBoundary ||
    fact.argumentPlanAmbiguous === true ||
    fact.traitDispatch === true ||
    fact.openTraitDispatch === true ||
    fact.targets.length === 0;
  const reusesSpecializedBoundaryContract =
    fact.intrinsicBoundary ||
    fact.argumentPlanAmbiguous === true ||
    (fact.targets.length === 0 &&
      fact.traitDispatch !== true &&
      fact.openTraitDispatch !== true);
  const unspecialized =
    usesExtractedBoundaryContract || currentContracts.length === 0
      ? fact.baseContract
      : currentContracts.length === 1
        ? currentContracts[0]
        : mergeCallableBorrowContracts(currentContracts);
  const arguments_ = fact.substitutions.map(
    (substitution) => substitution.argument,
  );
  const specialized =
    !reusesSpecializedBoundaryContract && unspecialized
      ? specializeConditionalContract(unspecialized, expr, arguments_, ctx)
      : undefined;
  const contract = reusesSpecializedBoundaryContract
    ? unspecialized
    : specialized
      ? filterConcreteProvenance(
          specialized,
          expressionTypeFor(expr.id, ctx),
          arguments_,
          ctx,
        )
      : undefined;
  const result: ResolvedBorrowCall = {
    target: fact.targets.length === 1 ? fact.targets[0] : undefined,
    targets: fact.targets,
    ...(fact.signature ? { signature: fact.signature } : {}),
    ...(contract ? { contract } : {}),
    arguments: arguments_,
    contractSources: fact.contractSources,
    ...(fact.traitDispatch ? { traitDispatch: true as const } : {}),
    ...(fact.openTraitDispatch ? { openTraitDispatch: true as const } : {}),
    ...(fact.argumentPlanAmbiguous
      ? { argumentPlanAmbiguous: true as const }
      : {}),
  };
  ctx.callResolutionCache?.set(expr.id, result);
  return result;
};

export const resolveBorrowCallTargets = (
  expr: HirExpression,
  ctx: ResolveContext,
): readonly SymbolRef[] => borrowCallTargets(expr, ctx).targets;

export const abstractTraitContractFromImplementation = ({
  contract,
  named,
  privateFieldNames,
}: {
  contract: CallableBorrowContract;
  named: CheckedNamedBorrowContract;
  privateFieldNames?: ReadonlySet<string>;
}): CallableBorrowContract => {
  const disjointFor = (name: string): readonly string[] =>
    named.disjoint.flatMap(([left, right]) =>
      left === name ? [right] : right === name ? [left] : [],
    );
  const publicPath = (
    path: readonly PlaceProjection[],
  ): readonly PlaceProjection[] => {
    const privateIndex = path.findIndex(
      (projection) =>
        projection.kind === "field" &&
        (privateFieldNames === undefined ||
          privateFieldNames.has(projection.name)),
    );
    return privateIndex < 0 ? path : path.slice(0, privateIndex);
  };
  const abstractPath = (
    path: readonly PlaceProjection[],
    parameter: number,
  ): readonly PlaceProjection[] => {
    if (parameter !== 0) {
      return publicPath(path);
    }
    const mapped = named.regions
      .filter(
        (
          region,
        ): region is typeof region & {
          parameter: number;
          place: readonly PlaceProjection[];
        } => region.parameter === parameter && region.place !== undefined,
      )
      .filter(
        (region) =>
          projectionPathCovers(region.place, path) ||
          mappedAllocationCoversReturnedBorrow(region.place, path) ||
          projectionPathCovers(path, region.place),
      )
      .sort((left, right) => right.place.length - left.place.length)[0];
    if (!mapped) {
      if (path.length === 0) {
        return [];
      }
      const privateRegion = {
        kind: "region" as const,
        scope: `${named.scope}:implementation-private`,
        name: "receiver",
        disjoint: [],
      };
      return path.some((projection) => projection.kind === "dereference")
        ? [privateRegion, { kind: "dereference" }]
        : [privateRegion];
    }
    const remainder = projectionPathCovers(mapped.place, path)
      ? publicPath(path.slice(mapped.place.length))
      : [];
    return [
      {
        kind: "region",
        scope: named.scope,
        name: mapped.name,
        disjoint: disjointFor(mapped.name),
      },
      ...remainder,
    ];
  };
  const abstractPaths = (
    paths: readonly (readonly PlaceProjection[])[] | undefined,
    parameter: number,
  ): readonly (readonly PlaceProjection[])[] | undefined =>
    paths?.map((path) => abstractPath(path, parameter));
  const abstractOrigin = <T extends ReturnedBorrowOrigin>(
    origin: T,
    parameter: number,
  ): T => {
    const source = abstractPath(
      origin.endpointAccess === "dereferenced" &&
        origin.source.at(-1)?.kind !== "dereference"
        ? [...origin.source, { kind: "dereference" }]
        : origin.source,
      parameter,
    );
    const endpointAccess =
      parameter === 0 ? ("inline" as const) : origin.endpointAccess;
    const result = publicPath(origin.result);
    return {
      ...origin,
      source,
      result,
      ...(endpointAccess ? { endpointAccess } : {}),
      ...("conditionId" in origin
        ? {
            conditionId: borrowTypeConditionId({
              parameter,
              sourcePath: source,
              resultPath: result,
              endpointAccess,
            }),
          }
        : {}),
    } as T;
  };
  const parameters = contract.parameters.map((parameter, index) => {
    return {
      ...parameter,
      ...(parameter.readPaths
        ? { readPaths: abstractPaths(parameter.readPaths, index) }
        : {}),
      ...(parameter.writePaths
        ? { writePaths: abstractPaths(parameter.writePaths, index) }
        : {}),
      ...(parameter.retainedPaths
        ? { retainedPaths: abstractPaths(parameter.retainedPaths, index) }
        : {}),
      ...(parameter.externalRetainedPaths
        ? {
            externalRetainedPaths: abstractPaths(
              parameter.externalRetainedPaths,
              index,
            ),
          }
        : {}),
      ...(parameter.borrowedRetainedPaths
        ? {
            borrowedRetainedPaths: abstractPaths(
              parameter.borrowedRetainedPaths,
              index,
            ),
          }
        : {}),
      ...(parameter.returnedPaths
        ? { returnedPaths: abstractPaths(parameter.returnedPaths, index) }
        : {}),
      ...(parameter.invalidatedPaths
        ? { invalidatedPaths: abstractPaths(parameter.invalidatedPaths, index) }
        : {}),
      ...(parameter.returnedOrigins
        ? {
            returnedOrigins: parameter.returnedOrigins.map((origin) =>
              abstractOrigin(origin, index),
            ),
          }
        : {}),
      ...(parameter.returnedSharedOrigins
        ? {
            returnedSharedOrigins: parameter.returnedSharedOrigins.map(
              (origin) => abstractOrigin(origin, index),
            ),
          }
        : {}),
      ...(parameter.returnedTypeMatchingOrigins
        ? {
            returnedTypeMatchingOrigins:
              parameter.returnedTypeMatchingOrigins.map((origin) =>
                abstractOrigin(origin, index),
              ),
          }
        : {}),
      ...(parameter.accessIfResultTypeDiffers
        ? {
            accessIfResultTypeDiffers: {
              ...parameter.accessIfResultTypeDiffers,
              ...(() => {
                const sourcePath = abstractPath(
                  parameter.accessIfResultTypeDiffers!.sourcePath,
                  parameter.accessIfResultTypeDiffers!.parameter,
                );
                const resultPath = publicPath(
                  parameter.accessIfResultTypeDiffers!.resultPath,
                );
                return {
                  sourcePath,
                  resultPath,
                  conditionId: borrowTypeConditionId({
                    parameter: parameter.accessIfResultTypeDiffers!.parameter,
                    sourcePath,
                    resultPath,
                    endpointAccess:
                      parameter.accessIfResultTypeDiffers!.endpointAccess,
                  }),
                };
              })(),
            },
          }
        : {}),
      ...(parameter.defaultOrigins
        ? {
            defaultOrigins: parameter.defaultOrigins.map((origin) => ({
              ...origin,
              source: abstractPath(origin.source, origin.parameter),
              result: publicPath(origin.result),
            })),
          }
        : {}),
      ...(parameter.defaultReadOrigins
        ? {
            defaultReadOrigins: parameter.defaultReadOrigins.map((origin) => ({
              ...origin,
              path: abstractPath(origin.path, origin.parameter),
            })),
          }
        : {}),
      ...(parameter.defaultWriteOrigins
        ? {
            defaultWriteOrigins: parameter.defaultWriteOrigins.map(
              (origin) => ({
                ...origin,
                path: abstractPath(origin.path, origin.parameter),
              }),
            ),
          }
        : {}),
      ...(parameter.defaultExternalOrigins
        ? {
            defaultExternalOrigins: parameter.defaultExternalOrigins.map(
              (origin) => ({ ...origin, result: publicPath(origin.result) }),
            ),
          }
        : {}),
      ...(parameter.defaultExternalReturnedOrigins
        ? {
            defaultExternalReturnedOrigins:
              parameter.defaultExternalReturnedOrigins.map((origin) => ({
                ...origin,
                result: publicPath(origin.result),
              })),
          }
        : {}),
    };
  });
  const { dynamicDispatch: _dynamicDispatch, ...baseContract } = contract;
  return {
    ...baseContract,
    parameters,
    ...(contract.transfers
      ? {
          transfers: contract.transfers.map((transfer) => ({
            ...transfer,
            ...(transfer.sourcePath
              ? {
                  sourcePath: abstractPath(
                    transfer.sourcePath,
                    transfer.sourceParameter,
                  ),
                }
              : {}),
            ...(transfer.destinationPath
              ? {
                  destinationPath: abstractPath(
                    transfer.destinationPath,
                    transfer.destinationParameter,
                  ),
                }
              : {}),
          })),
        }
      : {}),
    ...(contract.externalReturnedOrigins
      ? {
          externalReturnedOrigins: contract.externalReturnedOrigins.map(
            (origin) => ({ ...origin, result: publicPath(origin.result) }),
          ),
        }
      : {}),
    ...(contract.scopedCallbacks
      ? {
          scopedCallbacks: contract.scopedCallbacks.map((callback) => {
            const { callbackPath: _callbackPath, ...publicCallback } = callback;
            return publicCallback;
          }),
        }
      : {}),
  };
};
