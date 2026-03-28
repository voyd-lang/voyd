import binaryen from "binaryen";
import {
  binaryenTypeToHeapType,
  defineStructType,
  refFunc,
  refCast,
  TypeBuilderBuildError,
} from "@voyd/lib/binaryen-gc/index.js";
import { mapPrimitiveToWasm } from "./primitive-types.js";
export { getFunctionRefType } from "./closure-types.js";
import { ensureClosureTypeInfo } from "./closure-types.js";
import {
  ensureFixedArrayWasmTypes,
  ensureFixedArrayWasmTypesByElement,
  ensureInlineFixedArrayWasmTypes,
} from "./fixed-array-types.js";
import { MAX_MULTIVALUE_INLINE_LANES } from "./multivalue.js";
import type { AugmentedBinaryen } from "@voyd/lib/binaryen-gc/types.js";
import { RTT_METADATA_SLOT_COUNT } from "./rtt/index.js";
import {
  pickTraitImplMethodMeta,
} from "./function-lookup.js";
import type {
  CodegenContext,
  ClosureTypeInfo,
  FunctionMetadata,
  HirFunction,
  StructuralFieldInfo,
  StructuralTypeInfo,
  HirTypeExpr,
  HirExprId,
  HirPattern,
  SymbolId,
  FixedArrayWasmType,
  OptimizedValueAbiKind,
} from "./context.js";
import type { MethodAccessorEntry } from "./rtt/method-accessor.js";
import type { CodegenTraitImplInstance } from "../semantics/codegen-view/index.js";
import type {
  ProgramFunctionInstanceId,
  ProgramSymbolId,
  TypeParamId,
  TypeId,
} from "../semantics/ids.js";
import { buildInstanceSubstitution } from "./type-substitution.js";
import { getSccContainingRoot } from "./graph/scc.js";
import { emitRecursiveStructuralHeapTypeGroup } from "./structural-heap-type-emitter.js";
import { typeContainsUnresolvedParam } from "../semantics/type-utils.js";
import {
  traitDispatchHash,
  traitDispatchSignatureKey,
} from "./trait-dispatch-key.js";
import { wrapValueInOutcome } from "./effects/outcome-values.js";
import {
  isTraitDispatchMethodEffectful,
  resolveImportedFunctionSymbol,
} from "./trait-dispatch-abi.js";

const bin = binaryen as unknown as AugmentedBinaryen;
const REACHABILITY_STATE = Symbol.for("voyd.codegen.reachabilityState");
const FUNCTION_METADATA_REGISTRATION_STATE = Symbol.for(
  "voyd.codegen.functionMetadataRegistrationState",
);

type ReachabilityState = {
  symbols?: Set<ProgramSymbolId>;
};

type FunctionMetadataRegistrationState = {
  active?: boolean;
};

const STRUCT_METADATA_STATE = Symbol.for("voyd.codegen.structMetadata");

type StructMetadataState = {
  registered?: Set<string>;
};

const INLINE_BOX_STATE = Symbol.for("voyd.codegen.inlineBoxes");

type InlineBoxState = {
  boxes?: Map<string, binaryen.Type>;
};

const NON_REF_TYPES = new Set<number>([
  binaryen.none,
  binaryen.unreachable,
  binaryen.i32,
  binaryen.i64,
  binaryen.f32,
  binaryen.f64,
]);

const isRefType = (type: binaryen.Type): boolean =>
  binaryen.expandType(type).length === 1 && !NON_REF_TYPES.has(type);

const expandAbiTypes = (type: binaryen.Type): binaryen.Type[] =>
  type === binaryen.none ? [] : [...binaryen.expandType(type)];

export const abiTypeFor = (types: readonly binaryen.Type[]): binaryen.Type => {
  if (types.length === 0) {
    return binaryen.none;
  }
  if (types.length === 1) {
    return types[0]!;
  }
  return binaryen.createType(types as number[]);
};

type InlineUnionMemberLayout = {
  typeId: TypeId;
  tag: number;
  abiTypes: readonly binaryen.Type[];
  abiStart: number;
};

type InlineUnionLayout = {
  typeId: TypeId;
  abiTypes: readonly binaryen.Type[];
  interfaceType: binaryen.Type;
  members: readonly InlineUnionMemberLayout[];
};

export type OptionalLayoutInfo = {
  optionalType: TypeId;
  innerType: TypeId;
  someType: TypeId;
  noneType: TypeId;
};

const nominalValueComponent = (
  typeId: TypeId,
  ctx: CodegenContext,
): TypeId | undefined => {
  const nominalId = getNominalComponentId(typeId, ctx);
  if (typeof nominalId !== "number") {
    return undefined;
  }
  return ctx.program.types.getTypeDesc(nominalId).kind === "value-object"
    ? nominalId
    : undefined;
};

const nominalObjectishComponent = (
  typeId: TypeId,
  ctx: CodegenContext,
): TypeId | undefined => {
  const nominalId = getNominalComponentId(typeId, ctx);
  if (typeof nominalId !== "number") {
    return undefined;
  }
  const nominalDesc = ctx.program.types.getTypeDesc(nominalId);
  return nominalDesc.kind === "nominal-object" || nominalDesc.kind === "value-object"
    ? nominalId
    : undefined;
};

const collectUnionMembers = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set(),
): TypeId[] => {
  if (seen.has(typeId)) {
    return [];
  }
  seen.add(typeId);
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "recursive") {
    const unfolded = ctx.program.types.substitute(
      desc.body,
      new Map([[desc.binder, typeId]]),
    );
    return collectUnionMembers(unfolded, ctx, seen);
  }
  if (desc.kind !== "union") {
    return [typeId];
  }
  return desc.members.flatMap((member) => collectUnionMembers(member, ctx, seen));
};

export const shouldInlineUnionLayout = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set(),
): boolean => {
  if (seen.has(typeId)) {
    return false;
  }
  seen.add(typeId);
  const optionalInfo = getOptionalLayoutInfo(typeId, ctx);
  if (optionalInfo) {
    const innerDesc = ctx.program.types.getTypeDesc(optionalInfo.innerType);
    if (innerDesc.kind === "primitive" || innerDesc.kind === "value-object") {
      return true;
    }
    if (innerDesc.kind === "intersection") {
      const nominalId = getNominalComponentId(optionalInfo.innerType, ctx);
      if (typeof nominalId === "number") {
        const nominalDesc = ctx.program.types.getTypeDesc(nominalId);
        return nominalDesc.kind === "value-object";
      }
    }
    return false;
  }
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "recursive") {
    const unfolded = ctx.program.types.substitute(
      desc.body,
      new Map([[desc.binder, typeId]]),
    );
    return shouldInlineUnionLayout(unfolded, ctx, seen);
  }
  if (desc.kind !== "union") {
    return false;
  }
  return desc.members.some((member) => {
    const memberDesc = ctx.program.types.getTypeDesc(member);
    if (memberDesc.kind === "value-object") {
      return true;
    }
    const nominalId = getNominalComponentId(member, ctx);
    if (typeof nominalId === "number") {
      const nominalDesc = ctx.program.types.getTypeDesc(nominalId);
      return nominalDesc.kind === "value-object";
    }
    return false;
  });
};

const flattenTypeToAbiTypes = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set(),
  mode: WasmTypeMode = "signature",
): binaryen.Type[] => {
  if (seen.has(typeId)) {
    return expandAbiTypes(wasmTypeFor(typeId, ctx, seen, mode));
  }
  seen.add(typeId);
  try {
    const desc = ctx.program.types.getTypeDesc(typeId);
    if (desc.kind === "recursive") {
      const unfolded = ctx.program.types.substitute(
        desc.body,
        new Map([[desc.binder, typeId]]),
      );
      return flattenTypeToAbiTypes(unfolded, ctx, seen, mode);
    }
    if (shouldInlineUnionLayout(typeId, ctx)) {
      return getInlineUnionLayout(typeId, ctx, seen, mode).abiTypes.slice();
    }
    if (desc.kind === "value-object") {
      const info = getStructuralTypeInfo(typeId, ctx, seen);
      if (!info) {
        throw new Error("missing value-object structural type info");
      }
      return info.fields.flatMap((field) => field.inlineWasmTypes);
    }
    if (desc.kind === "intersection") {
      const nominalId = getNominalComponentId(typeId, ctx);
      if (typeof nominalId === "number") {
        const nominalDesc = ctx.program.types.getTypeDesc(nominalId);
        if (nominalDesc.kind === "value-object") {
          const info = getStructuralTypeInfo(typeId, ctx, seen);
          if (!info) {
            throw new Error("missing value intersection structural type info");
          }
          return info.fields.flatMap((field) => field.inlineWasmTypes);
        }
      }
    }
    const lowerSeen = new Set(seen);
    lowerSeen.delete(typeId);
    return expandAbiTypes(wasmTypeFor(typeId, ctx, lowerSeen, mode));
  } finally {
    seen.delete(typeId);
  }
};

export const getInlineUnionLayout = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set(),
  mode: WasmTypeMode = "signature",
): InlineUnionLayout => {
  const optionalInfo = getOptionalLayoutInfo(typeId, ctx);
  if (optionalInfo && shouldInlineUnionLayout(typeId, ctx)) {
    const abiTypes = flattenTypeToAbiTypes(optionalInfo.innerType, ctx, seen, mode);
    return {
      typeId,
      abiTypes: [binaryen.i32, ...abiTypes],
      interfaceType: abiTypeFor([binaryen.i32, ...abiTypes]),
      members: [
        {
          typeId: optionalInfo.noneType,
          tag: 0,
          abiTypes: [],
          abiStart: 1,
        },
        {
          typeId: optionalInfo.someType,
          tag: 1,
          abiTypes,
          abiStart: 1,
        },
      ],
    };
  }
  const members = collectUnionMembers(typeId, ctx);
  let abiStart = 1;
  const memberLayouts = members.map((member, index) => {
    const abiTypes = flattenTypeToAbiTypes(member, ctx, seen, mode);
    const layout: InlineUnionMemberLayout = {
      typeId: member,
      tag: index,
      abiTypes,
      abiStart,
    };
    abiStart += abiTypes.length;
    return layout;
  });
  const abiTypes = [binaryen.i32, ...memberLayouts.flatMap((member) => member.abiTypes)];
  return {
    typeId,
    abiTypes,
    interfaceType: abiTypeFor(abiTypes),
    members: memberLayouts,
  };
};

export const getOptionalLayoutInfo = (
  typeId: TypeId,
  ctx: CodegenContext,
): OptionalLayoutInfo | undefined => {
  const direct = ctx.program.optionals.getOptionalInfo(ctx.moduleId, typeId);
  if (direct) {
    return direct;
  }

  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "recursive") {
    const unfolded = ctx.program.types.substitute(
      desc.body,
      new Map([[desc.binder, typeId]]),
    );
    return getOptionalLayoutInfo(unfolded, ctx);
  }

  if (desc.kind !== "union") {
    return undefined;
  }

  const members = collectUnionMembers(typeId, ctx);
  if (members.length !== 2) {
    return undefined;
  }

  const classified = members
    .map((member) => classifyOptionalMember({ typeId: member, ctx }))
    .filter((member): member is NonNullable<typeof member> => Boolean(member));
  if (classified.length !== 2) {
    return undefined;
  }

  const noneMember = classified.find((member) => member.kind === "none");
  const someMember = classified.find((member) => member.kind === "some");
  if (!noneMember || !someMember) {
    return undefined;
  }

  return {
    optionalType: typeId,
    innerType: someMember.innerType,
    someType: someMember.typeId,
    noneType: noneMember.typeId,
  };
};

const classifyOptionalMember = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}):
  | { kind: "none"; typeId: TypeId }
  | { kind: "some"; typeId: TypeId; innerType: TypeId }
  | undefined => {
  const nominalId = getNominalComponentId(typeId, ctx);
  if (typeof nominalId !== "number") {
    return undefined;
  }

  const nominalDesc = ctx.program.types.getTypeDesc(nominalId);
  if (
    nominalDesc.kind !== "nominal-object" &&
    nominalDesc.kind !== "value-object"
  ) {
    return undefined;
  }
  const ownerRef = ctx.program.symbols.refOf(nominalDesc.owner);
  if (ownerRef.moduleId !== "std::optional::types") {
    return undefined;
  }

  const structInfo = getStructuralTypeInfo(typeId, ctx);
  if (!structInfo) {
    return undefined;
  }

  if (nominalDesc.name === "None" && structInfo.fields.length === 0) {
    return { kind: "none", typeId };
  }

  if (
    nominalDesc.name === "Some" &&
    structInfo.fields.length === 1 &&
    structInfo.fields[0]!.name === "value"
  ) {
    return {
      kind: "some",
      typeId,
      innerType: structInfo.fields[0]!.typeId,
    };
  }

  return undefined;
};

export const getDirectAbiTypesForSignature = (
  typeId: TypeId,
  ctx: CodegenContext,
): readonly binaryen.Type[] => flattenTypeToAbiTypes(typeId, ctx, new Set(), "signature");

export const isWideValueType = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): boolean =>
  typeof getInlineHeapBoxType({ typeId, ctx }) === "number" &&
  getDirectAbiTypesForSignature(typeId, ctx).length > MAX_MULTIVALUE_INLINE_LANES;

export const getWideValueStorageType = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): binaryen.Type | undefined =>
  isWideValueType({ typeId, ctx }) ? getInlineHeapBoxType({ typeId, ctx }) : undefined;

export const getOptimizedParamAbiKind = ({
  typeId,
  bindingKind,
  ctx,
}: {
  typeId: TypeId;
  bindingKind?: string;
  ctx: CodegenContext;
}): OptimizedValueAbiKind => {
  if (
    bindingKind === "mutable-ref" &&
    typeof getInlineHeapBoxType({ typeId, ctx }) === "number"
  ) {
    return "mutable_ref";
  }
  if (!isWideValueType({ typeId, ctx })) {
    return "direct";
  }
  return bindingKind === "mutable-ref" ? "mutable_ref" : "readonly_ref";
};

export const getOptimizedResultAbiKind = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): OptimizedValueAbiKind =>
  isWideValueType({ typeId, ctx }) ? "out_ref" : "direct";

export const getOptimizedAbiTypesForParam = ({
  typeId,
  bindingKind,
  ctx,
}: {
  typeId: TypeId;
  bindingKind?: string;
  ctx: CodegenContext;
}): readonly binaryen.Type[] => {
  const abiKind = getOptimizedParamAbiKind({ typeId, bindingKind, ctx });
  if (abiKind === "direct") {
    return getAbiTypesForSignature(typeId, ctx);
  }
  const storageType = getInlineHeapBoxType({ typeId, ctx });
  if (typeof storageType !== "number") {
    throw new Error(`missing ref storage type for parameter ${typeId}`);
  }
  return [storageType];
};

export const getOptimizedAbiTypeForResult = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): binaryen.Type | undefined => {
  if (getOptimizedResultAbiKind({ typeId, ctx }) !== "out_ref") {
    return undefined;
  }
  const storageType = getWideValueStorageType({ typeId, ctx });
  if (typeof storageType !== "number") {
    throw new Error(`missing wide storage type for result ${typeId}`);
  }
  return storageType;
};

export const getSignatureSpillBoxType = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): binaryen.Type | undefined => {
  const abiTypes = getDirectAbiTypesForSignature(typeId, ctx);
  if (abiTypes.length <= MAX_MULTIVALUE_INLINE_LANES) {
    return undefined;
  }
  return ensureAbiBoxType({
    typeId,
    abiTypes,
    ctx,
    label: `${ctx.moduleLabel}__sig_${runtimeTypeKeyFor({ typeId, ctx })}`,
  });
};

export const getAbiTypesForSignature = (
  typeId: TypeId,
  ctx: CodegenContext,
): readonly binaryen.Type[] => {
  const spillBoxType = getSignatureSpillBoxType({ typeId, ctx });
  return spillBoxType
    ? [spillBoxType]
    : getDirectAbiTypesForSignature(typeId, ctx);
};

export const getSignatureWasmType = (
  typeId: TypeId,
  ctx: CodegenContext,
): binaryen.Type => abiTypeFor(getAbiTypesForSignature(typeId, ctx));

export const ensureAbiBoxType = ({
  typeId,
  abiTypes,
  ctx,
  label,
}: {
  typeId: TypeId;
  abiTypes: readonly binaryen.Type[];
  ctx: CodegenContext;
  label: string;
}): binaryen.Type => {
  if (abiTypes.length === 1) {
    return abiTypes[0]!;
  }
  const key = `${runtimeTypeKeyFor({ typeId, ctx })}::${abiTypes.join(",")}`;
  const cached = ctx.abiBoxTypes.get(key);
  if (cached) {
    return cached;
  }
  const boxType = defineStructType(ctx.mod, {
    name: `${label}__abi_box`,
    fields: abiTypes.map((type, index) => ({
      name: `v${index}`,
      type,
      mutable: false,
    })),
    supertype: binaryenTypeToHeapType(ctx.rtt.rootType),
    final: true,
  });
  ctx.abiBoxTypes.set(key, boxType);
  return boxType;
};

const getInlineBoxType = ({
  key,
  abiTypes,
  label,
  ctx,
}: {
  key: string;
  abiTypes: readonly binaryen.Type[];
  label: string;
  ctx: CodegenContext;
}): binaryen.Type => {
  const safeLabel = label.replace(/[^a-zA-Z0-9_]/g, "_");
  const state = ctx.programHelpers.getHelperState<InlineBoxState>(
    INLINE_BOX_STATE,
    () => ({ boxes: new Map<string, binaryen.Type>() }),
  );
  const boxes = state.boxes ?? new Map<string, binaryen.Type>();
  state.boxes = boxes;
  const cached = boxes.get(key);
  if (cached) {
    return cached;
  }
  const runtimeType = defineStructType(ctx.mod, {
    name: `${safeLabel}__box`,
    fields: abiTypes.map((type, index) => ({
      name: `v${index}`,
      type,
      mutable: true,
    })),
    supertype: binaryenTypeToHeapType(ctx.rtt.rootType),
    final: true,
  });
  boxes.set(key, runtimeType);
  return runtimeType;
};

export const getInlineHeapBoxType = ({
  typeId,
  ctx,
  seen = new Set<TypeId>(),
  mode = "signature",
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  seen?: Set<TypeId>;
  mode?: WasmTypeMode;
}): binaryen.Type | undefined => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "value-object") {
    return getStructuralTypeInfo(typeId, ctx, seen)?.runtimeType;
  }
  if (desc.kind === "intersection") {
    const nominalId = getNominalComponentId(typeId, ctx);
    if (typeof nominalId === "number") {
      const nominalDesc = ctx.program.types.getTypeDesc(nominalId);
      if (nominalDesc.kind === "value-object") {
        return getStructuralTypeInfo(typeId, ctx, seen)?.runtimeType;
      }
    }
  }
  if (!shouldInlineUnionLayout(typeId, ctx)) {
    return undefined;
  }
  const layout = getInlineUnionLayout(typeId, ctx, seen, mode);
  return getInlineBoxType({
    key: `union:${runtimeTypeKeyFor({ typeId, ctx })}:${layout.abiTypes.join(",")}`,
    abiTypes: layout.abiTypes,
    label: `${ctx.moduleLabel}__union_${runtimeTypeKeyFor({ typeId, ctx })}`,
    ctx,
  });
};

const markReachableFunctionSymbol = ({
  ctx,
  moduleId,
  symbol,
}: {
  ctx: CodegenContext;
  moduleId: string;
  symbol: SymbolId;
}): void => {
  const state = ctx.programHelpers.getHelperState<ReachabilityState>(
    REACHABILITY_STATE,
    () => ({ symbols: new Set<ProgramSymbolId>() }),
  );
  const symbols = state.symbols ?? new Set<ProgramSymbolId>();
  state.symbols = symbols;
  symbols.add(
    ctx.program.symbols.canonicalIdOf(moduleId, symbol) as ProgramSymbolId,
  );
};

export type WasmTypeMode = "runtime" | "signature";

type RuntimeTypeKeyState = {
  typeId: TypeId;
  ctx: CodegenContext;
  active: Map<TypeId, number>;
  binders: Map<TypeParamId, number>;
};

const runtimeTypeKeyFor = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): string =>
  runtimeTypeKeyForInternal({
    typeId,
    ctx,
    active: new Map<TypeId, number>(),
    binders: new Map<TypeParamId, number>(),
  });

const getRuntimeTypeIdentityTypeId = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set(),
): TypeId => {
  if (seen.has(typeId)) {
    return typeId;
  }
  seen.add(typeId);
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "recursive") {
    return getRuntimeTypeIdentityTypeId(desc.body, ctx, seen);
  }
  if (desc.kind === "intersection") {
    if (typeof desc.nominal === "number") {
      return getRuntimeTypeIdentityTypeId(desc.nominal, ctx, seen);
    }
    if (typeof desc.structural === "number") {
      return getRuntimeTypeIdentityTypeId(desc.structural, ctx, seen);
    }
  }
  return typeId;
};

const runtimeTypeKeyForInternal = ({
  typeId,
  ctx,
  active,
  binders,
}: RuntimeTypeKeyState): string => {
  const activeIndex = active.get(typeId);
  if (typeof activeIndex === "number") {
    return `recursive:${activeIndex}`;
  }
  active.set(typeId, active.size);

  try {
    const desc = ctx.program.types.getTypeDesc(typeId);
    switch (desc.kind) {
      case "primitive":
        return `prim:${desc.name}`;
      case "recursive": {
        const binderIndex = binders.size;
        const nextBinders = new Map(binders);
        nextBinders.set(desc.binder, binderIndex);
        return `mu:${binderIndex}.${runtimeTypeKeyForInternal({
          typeId: desc.body,
          ctx,
          active,
          binders: nextBinders,
        })}`;
      }
      case "type-param-ref": {
        const binderIndex = binders.get(desc.param);
        return typeof binderIndex === "number"
          ? `recparam:${binderIndex}`
          : `typeparam:${desc.param}`;
      }
      case "nominal-object":
        return `nominal:${desc.owner}<${desc.typeArgs
          .map((arg) =>
            runtimeTypeKeyForInternal({ typeId: arg, ctx, active, binders }),
          )
          .join(",")}>`;
      case "value-object":
        return `value:${desc.owner}<${desc.typeArgs
          .map((arg) =>
            runtimeTypeKeyForInternal({ typeId: arg, ctx, active, binders }),
          )
          .join(",")}>`;
      case "trait":
        return `trait:${desc.owner}<${desc.typeArgs
          .map((arg) =>
            runtimeTypeKeyForInternal({ typeId: arg, ctx, active, binders }),
          )
          .join(",")}>`;
      case "structural-object":
        return `struct:{${desc.fields
          .map(
            (field) =>
              `${field.name}${field.optional ? "?" : ""}:${runtimeTypeKeyForInternal(
                {
                  typeId: field.type,
                  ctx,
                  active,
                  binders,
                },
              )}`,
          )
          .join(",")}}`;
      case "function":
        return `fn:(${desc.parameters
          .map((param) =>
            runtimeTypeKeyForInternal({
              typeId: param.type,
              ctx,
              active,
              binders,
            }),
          )
          .join(",")})->${runtimeTypeKeyForInternal({
          typeId: desc.returnType,
          ctx,
          active,
          binders,
        })}`;
      case "union": {
        const members = desc.members
          .map((member) =>
            runtimeTypeKeyForInternal({ typeId: member, ctx, active, binders }),
          )
          .sort();
        return `union:${members.join("|")}`;
      }
      case "intersection": {
        if (typeof desc.nominal === "number") {
          return runtimeTypeKeyForInternal({
            typeId: desc.nominal,
            ctx,
            active,
            binders,
          });
        }
        if (typeof desc.structural === "number") {
          return `intersection:${runtimeTypeKeyForInternal({
            typeId: desc.structural,
            ctx,
            active,
            binders,
          })}`;
        }
        const traits =
          desc.traits && desc.traits.length > 0
            ? desc.traits
                .map((trait) =>
                  runtimeTypeKeyForInternal({
                    typeId: trait,
                    ctx,
                    active,
                    binders,
                  }),
                )
                .sort()
                .join("|")
            : "none";
        return `intersection:traits:${traits}`;
      }
      case "fixed-array":
        return `fixed-array:${runtimeTypeKeyForInternal({
          typeId: desc.element,
          ctx,
          active,
          binders,
        })}`;
      default:
        return `${(desc as { kind: string }).kind}:${typeId}`;
    }
  } finally {
    active.delete(typeId);
  }
};

const runtimeTypeIdFor = (typeId: TypeId, ctx: CodegenContext): number =>
  (() => {
    const identityTypeId = getRuntimeTypeIdentityTypeId(typeId, ctx);
    const key = runtimeTypeKeyFor({ typeId: identityTypeId, ctx });
    const existing = ctx.runtimeTypeRegistry.get(typeId);
    if (!existing) {
      ctx.runtimeTypeRegistry.set(typeId, {
        key,
        moduleId: ctx.moduleId,
        typeId: identityTypeId,
      });
    }

    const cached = ctx.runtimeTypeIds.byKey.get(key);
    if (cached !== undefined) {
      return cached;
    }

    const id = ctx.runtimeTypeIds.nextId.value;
    ctx.runtimeTypeIds.nextId.value += 1;
    ctx.runtimeTypeIds.byKey.set(key, id);
    return id;
  })();

const getLocalSymbolName = (symbol: SymbolId, ctx: CodegenContext): string =>
  ctx.program.symbols.getName(
    ctx.program.symbols.idOf({ moduleId: ctx.moduleId, symbol }),
  ) ?? `${symbol}`;

export const getClosureTypeInfo = (
  typeId: TypeId,
  ctx: CodegenContext,
): ClosureTypeInfo => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind !== "function") {
    throw new Error("expected function type for closure info");
  }
  return ensureClosureTypeInfo({
    typeId,
    desc,
    ctx,
    seen: new Set<TypeId>(),
    mode: "signature",
    lowerType: (id, ctx, seen, mode) => wasmTypeFor(id, ctx, seen, mode),
  });
};

export const getFixedArrayWasmTypes = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set(),
  mode: WasmTypeMode = "runtime",
): FixedArrayWasmType => {
  const activeGroup = ctx.activeRecursiveHeapTypeGroup;
  if (activeGroup) {
    const desc = ctx.program.types.getTypeDesc(typeId);
    if (desc.kind === "fixed-array") {
      const elementStructural = resolveStructuralTypeId(desc.element, ctx);
      if (
        typeof elementStructural === "number" &&
        activeGroup.structuralIds.has(elementStructural)
      ) {
        const tempArrayType =
          activeGroup.fixedArrayTempRefsByElementStructuralId.get(
            elementStructural,
          );
        if (typeof tempArrayType === "number") {
          return {
            kind: "plain-array",
            type: tempArrayType,
            heapType: binaryenTypeToHeapType(tempArrayType),
          };
        }
      }
    }
  }

  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind !== "fixed-array") {
    throw new Error("intrinsic requires a fixed-array type");
  }
  const laneTypes = flattenTypeToAbiTypes(desc.element, ctx, seen, "signature");
  const inlineElementBox = getInlineHeapBoxType({
    typeId: desc.element,
    ctx,
    seen: new Set(seen),
    mode: "signature",
  });
  if (typeof inlineElementBox === "number" || laneTypes.length > 1) {
    return ensureInlineFixedArrayWasmTypes({
      key: `${runtimeTypeKeyFor({ typeId: desc.element, ctx })}:${laneTypes.join(",")}`,
      laneTypes,
      ctx,
    });
  }

  return ensureFixedArrayWasmTypes({
    typeId,
    ctx,
    seen,
    mode,
    // Wasm GC arrays are invariant, so fixed-array element heap types must stay
    // concrete even when the caller is lowering a signature.
    lowerType: (id, ctx, seen) =>
      wasmHeapFieldTypeFor(id, ctx, seen, "runtime"),
  });
};

export const wasmTypeFor = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set(),
  mode: WasmTypeMode = "runtime",
): binaryen.Type => {
  const already = seen.has(typeId);
  if (already) {
    const desc = ctx.program.types.getTypeDesc(typeId);
    // Recursive heap types are widened for now; see docs/proposals/recursive-heap-types.md.
    if (desc.kind === "function") {
      return binaryen.funcref;
    }
    if (desc.kind === "fixed-array") {
      const elementType = wasmHeapFieldTypeFor(
        desc.element,
        ctx,
        seen,
        "runtime",
      );
      return ensureFixedArrayWasmTypesByElement({ elementType, ctx }).type;
    }
    if (desc.kind === "value-object") {
      const structInfo = getStructuralTypeInfo(typeId, ctx, seen);
      if (structInfo) {
        return structInfo.interfaceType;
      }
    }
    return ctx.rtt.baseType;
  }
  seen.add(typeId);

  try {
    const desc = ctx.program.types.getTypeDesc(typeId);
    const descKind = desc.kind;
    if (desc.kind === "recursive") {
      ctx.recursiveBinders.set(desc.binder, typeId);
      const unfolded = ctx.program.types.substitute(
        desc.body,
        new Map([[desc.binder, typeId]]),
      );
      return wasmTypeFor(unfolded, ctx, seen, mode);
    }
    if (desc.kind === "primitive") {
      return mapPrimitiveToWasm(desc.name);
    }

    if (desc.kind === "fixed-array") {
      // Fixed arrays are invariant in wasm GC, so signatures must use the concrete
      // runtime array type to remain type-correct.
      return getFixedArrayWasmTypes(typeId, ctx, seen, mode).type;
    }

    if (desc.kind === "function") {
      const info = ensureClosureTypeInfo({
        typeId,
        desc,
        ctx,
        seen,
        mode,
        lowerType: (id, ctx, seen, mode) => wasmTypeFor(id, ctx, seen, mode),
      });
      return info.interfaceType;
    }

    if (desc.kind === "trait") {
      return ctx.rtt.baseType;
    }

    if (desc.kind === "nominal-object") {
      if (mode === "signature") {
        return ctx.rtt.baseType;
      }
      const structInfo = getStructuralTypeInfo(typeId, ctx, seen);
      if (!structInfo) {
        throw new Error("missing structural type info");
      }
      return structInfo.interfaceType;
    }

    if (desc.kind === "value-object") {
      const structInfo = getStructuralTypeInfo(typeId, ctx, seen);
      if (!structInfo) {
        throw new Error("missing structural type info");
      }
      return structInfo.interfaceType;
    }

    if (desc.kind === "structural-object") {
      if (mode === "signature") {
        return ctx.rtt.baseType;
      }
      const structInfo = getStructuralTypeInfo(typeId, ctx, seen);
      if (!structInfo) {
        throw new Error("missing structural type info");
      }
      return structInfo.interfaceType;
    }

    if (shouldInlineUnionLayout(typeId, ctx)) {
      return getInlineUnionLayout(typeId, ctx, seen, mode).interfaceType;
    }

    if (desc.kind === "union") {
      if (desc.members.length === 0) {
        throw new Error("cannot map empty union to wasm");
      }
      const memberTypes = desc.members.map((member) =>
        wasmTypeFor(member, ctx, seen, mode),
      );
      const first = memberTypes[0]!;
      if (!memberTypes.every((candidate) => candidate === first)) {
        if (memberTypes.every(isRefType)) {
          const hasValueMember = desc.members.some((member) =>
            typeof nominalValueComponent(member, ctx) === "number"
          );
          const allObjectish = desc.members.every((member) => {
            const memberDesc = ctx.program.types.getTypeDesc(member);
            return (
              memberDesc.kind === "trait" ||
              memberDesc.kind === "structural-object" ||
              memberDesc.kind === "intersection" ||
              typeof nominalObjectishComponent(member, ctx) === "number"
            );
          });
          if (allObjectish && !hasValueMember) {
            return ctx.rtt.baseType;
          }
          return hasValueMember ? binaryen.anyref : ctx.rtt.baseType;
        }
        throw new Error("union members map to different wasm types");
      }
      return first;
    }

    if (desc.kind === "intersection" && typeof desc.structural === "number") {
      if (mode === "signature") {
        const nominalDesc =
          typeof desc.nominal === "number"
            ? ctx.program.types.getTypeDesc(desc.nominal)
            : undefined;
        if (nominalDesc?.kind !== "value-object") {
          return ctx.rtt.baseType;
        }
      }
      const structInfo = getStructuralTypeInfo(typeId, ctx, seen);
      if (!structInfo) {
        throw new Error("missing structural type info");
      }
      if (mode === "signature") {
        const nominalId = getNominalComponentId(typeId, ctx);
        if (typeof nominalId === "number") {
          const nominalDesc = ctx.program.types.getTypeDesc(nominalId);
          if (nominalDesc.kind === "value-object") {
            return structInfo.interfaceType;
          }
        }
        return ctx.rtt.baseType;
      }
      return structInfo.interfaceType;
    }
    if (desc.kind === "intersection") {
      return ctx.rtt.baseType;
    }

    if (desc.kind === "type-param-ref") {
      const binderRecursive = ctx.recursiveBinders.get(desc.param);
      if (typeof binderRecursive === "number") {
        return wasmTypeFor(binderRecursive, ctx, seen, mode);
      }
      const inScopeRecursive = Array.from(seen).find((candidate) => {
        const candidateDesc = ctx.program.types.getTypeDesc(candidate);
        return (
          candidateDesc.kind === "recursive" &&
          candidateDesc.binder === desc.param
        );
      });
      if (typeof inScopeRecursive === "number") {
        return wasmTypeFor(inScopeRecursive, ctx, seen, mode);
      }
      // wasm has no type parameters; treat unresolved params conservatively.
      return ctx.rtt.baseType;
    }

    throw new Error(
      `codegen cannot map ${descKind} types to wasm yet (module ${ctx.moduleId}, type ${typeId})`,
    );
  } finally {
    seen.delete(typeId);
  }
};

const STRUCTURAL_HEAP_TYPE_PREFIX = "voyd_struct_shape";

const structuralHeapTypeName = (structuralId: TypeId): string =>
  `${STRUCTURAL_HEAP_TYPE_PREFIX}_${structuralId}`;

const directStructuralDeps = (
  structuralId: TypeId,
  ctx: CodegenContext,
): TypeId[] => {
  const desc = ctx.program.types.getTypeDesc(structuralId);
  if (desc.kind !== "structural-object") {
    return [];
  }
  const deps = new Set<TypeId>();

  const collect = (root: TypeId): void => {
    const active = new Set<TypeId>();
    const pending: TypeId[] = [root];
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (active.has(current)) {
        continue;
      }
      active.add(current);

      const resolved = resolveStructuralTypeId(current, ctx);
      if (typeof resolved === "number") {
        deps.add(resolved);
        continue;
      }

      const inner = ctx.program.types.getTypeDesc(current);
      if (inner.kind === "fixed-array") {
        pending.push(inner.element);
        continue;
      }
      if (inner.kind === "union") {
        inner.members.forEach((member) => pending.push(member));
        continue;
      }
      if (inner.kind === "intersection") {
        if (typeof inner.nominal === "number") {
          pending.push(inner.nominal);
        }
        if (typeof inner.structural === "number") {
          pending.push(inner.structural);
        }
        inner.traits?.forEach((trait) => pending.push(trait));
        continue;
      }
      if (inner.kind === "trait") {
        inner.typeArgs.forEach((arg) => pending.push(arg));
        continue;
      }
      if (inner.kind === "function") {
        inner.parameters.forEach((param) => pending.push(param.type));
        pending.push(inner.returnType);
      }
    }
  };

  desc.fields.forEach((field) => collect(field.type));
  return Array.from(deps).sort((a, b) => a - b);
};

const ensureStructuralRuntimeType = (
  structuralId: TypeId,
  ctx: CodegenContext,
): binaryen.Type => {
  const cached = ctx.structHeapTypes.get(structuralId);
  if (cached) {
    return cached;
  }
  if (ctx.resolvingStructuralHeapTypes.has(structuralId)) {
    return ctx.rtt.baseType;
  }
  ctx.resolvingStructuralHeapTypes.add(structuralId);

  try {
    const depsCache = new Map<TypeId, readonly TypeId[]>();
    const getDeps = (id: TypeId): readonly TypeId[] => {
      const existing = depsCache.get(id);
      if (existing) {
        return existing;
      }
      const computed = directStructuralDeps(id, ctx);
      depsCache.set(id, computed);
      return computed;
    };

    const scc = getSccContainingRoot({ root: structuralId, getDeps });

    const isRecursive =
      scc.length > 1 || getDeps(structuralId).some((dep) => dep === structuralId);

    const baseHeapType = binaryenTypeToHeapType(ctx.rtt.baseType);

    const lowerNonStructural = (
      typeId: TypeId,
      _ownerStructuralId?: TypeId,
    ): binaryen.Type =>
      wasmTypeFor(
        typeId,
        ctx,
        new Set(),
        "signature",
      );

    const buildNonRecursive = (id: TypeId): binaryen.Type => {
      getDeps(id).forEach((dep) => {
        if (dep !== id) {
          ensureStructuralRuntimeType(dep, ctx);
        }
      });

      const desc = ctx.program.types.getTypeDesc(id);
      if (desc.kind !== "structural-object") {
        throw new Error(`expected structural-object type ${id}`);
      }

      const structType = defineStructType(ctx.mod, {
        name: structuralHeapTypeName(id),
        fields: [
          {
            name: "__ancestors_table",
            type: ctx.rtt.extensionHelpers.i32Array,
            mutable: false,
          },
          {
            name: "__field_index_table",
            type: ctx.rtt.fieldLookupHelpers.lookupTableType,
            mutable: false,
          },
          {
            name: "__method_lookup_table",
            type: ctx.rtt.methodLookupHelpers.lookupTableType,
            mutable: false,
          },
          ...desc.fields.map((field) => {
            const type = lowerHeapObjectFieldRuntimeType({
              typeId: field.type,
              ownerStructuralId: id,
              ctx,
            });
            return { name: field.name, type, mutable: true };
          }),
        ],
        supertype: baseHeapType,
        final: true,
      });
      ctx.structHeapTypes.set(id, structType);
      return structType;
    };

    if (!isRecursive) {
      return buildNonRecursive(structuralId);
    }

    const alreadyBuilt = scc.filter((id) => ctx.structHeapTypes.has(id));
    if (alreadyBuilt.length > 0) {
      const missing = scc.filter((id) => !ctx.structHeapTypes.has(id));
      if (missing.length > 0) {
        throw new Error(
          `partial recursive heap type cache: built [${alreadyBuilt.join(
            ",",
          )}], missing [${missing.join(",")}]`,
        );
      }
      return ctx.structHeapTypes.get(structuralId)!;
    }

    try {
      emitRecursiveStructuralHeapTypeGroup({
        component: scc,
        ctx,
        getDirectDeps: getDeps,
        structNameFor: structuralHeapTypeName,
        resolveStructuralTypeId: (typeId) => resolveStructuralTypeId(typeId, ctx),
        ensureStructuralRuntimeType: (id) => ensureStructuralRuntimeType(id, ctx),
        lowerNonStructural: (typeId, ownerStructuralId) =>
          lowerNonStructural(typeId, ownerStructuralId),
        baseHeapType,
      });
    } catch (error) {
      if (error instanceof TypeBuilderBuildError) {
        ctx.diagnostics.report({
          code: "CG_RECURSIVE_HEAP_TYPE_BUILDER_FAILED",
          phase: "codegen",
          message: [
            "failed to build recursive heap type group",
            `module: ${ctx.moduleId}`,
            `structural type: ${structuralId}`,
            `error index: ${error.errorIndex}`,
            `error reason: ${error.errorReason}`,
          ].join("\n"),
          span: { file: ctx.moduleId, start: 0, end: 0 },
        });
      }
      throw error;
    }
    const built = ctx.structHeapTypes.get(structuralId);
    if (!built) {
      throw new Error(
        `failed to cache runtime heap type for structural id ${structuralId}`,
      );
    }
    return built;
  } finally {
    ctx.resolvingStructuralHeapTypes.delete(structuralId);
  }
};

const isStructurallyRecursive = (
  structuralId: TypeId,
  ctx: CodegenContext,
): boolean => {
  const depsCache = new Map<TypeId, readonly TypeId[]>();
  const getDeps = (id: TypeId): readonly TypeId[] => {
    const existing = depsCache.get(id);
    if (existing) {
      return existing;
    }
    const computed = directStructuralDeps(id, ctx);
    depsCache.set(id, computed);
    return computed;
  };
  const scc = getSccContainingRoot({ root: structuralId, getDeps });
  return scc.length > 1 || getDeps(structuralId).some((dep) => dep === structuralId);
};

const lowerHeapObjectFieldRuntimeType = ({
  typeId,
  ownerStructuralId,
  ctx,
}: {
  typeId: TypeId;
  ownerStructuralId: TypeId;
  ctx: CodegenContext;
}): binaryen.Type => {
  const assertHeapCompatible = (candidate: binaryen.Type): binaryen.Type => {
    if (binaryen.expandType(candidate).length > 1) {
      throw new Error(
        `heap field lowered to multivalue type for owner ${ownerStructuralId}, field ${typeId}`,
      );
    }
    return candidate;
  };
  const inlineBoxType = getInlineHeapBoxType({
    typeId,
    ctx,
    seen: new Set([ownerStructuralId]),
    mode: "signature",
  });
  if (inlineBoxType) {
    return assertHeapCompatible(inlineBoxType);
  }
  const abiTypes = flattenTypeToAbiTypes(
    typeId,
    ctx,
    new Set([ownerStructuralId]),
    "signature",
  );
  if (abiTypes.length > 1) {
    const inlineBoxType = getInlineHeapBoxType({
      typeId,
      ctx,
      seen: new Set([ownerStructuralId]),
      mode: "signature",
    });
    if (inlineBoxType) {
      return assertHeapCompatible(inlineBoxType);
    }
    return assertHeapCompatible(ensureAbiBoxType({
      typeId,
      abiTypes,
      ctx,
      label: `voyd_field_${ownerStructuralId}_${typeId}`,
    }));
  }
  const fieldStructural = resolveStructuralTypeId(typeId, ctx);
  if (typeof fieldStructural === "number") {
    if (isStructurallyRecursive(fieldStructural, ctx)) {
      return assertHeapCompatible(ensureStructuralRuntimeType(fieldStructural, ctx));
    }
    const info = getStructuralTypeInfo(
      fieldStructural,
      ctx,
      new Set([ownerStructuralId]),
    );
    if (info) {
      return assertHeapCompatible(info.runtimeType);
    }
  }
  return assertHeapCompatible(
    wasmTypeFor(typeId, ctx, new Set([ownerStructuralId]), "signature"),
  );
};

const wasmStructFieldTypeFor = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set(),
): binaryen.Type => {
  return wasmHeapFieldTypeFor(typeId, ctx, seen);
};

export const wasmHeapFieldTypeFor = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set(),
  mode: WasmTypeMode = "signature",
): binaryen.Type => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  const inlineBoxType = getInlineHeapBoxType({ typeId, ctx, seen, mode });
  if (inlineBoxType) {
    return inlineBoxType;
  }
  if (desc.kind === "value-object") {
    const info = getStructuralTypeInfo(typeId, ctx, seen);
    if (!info) {
      throw new Error("missing structural type info for value object field");
    }
    return info.runtimeType;
  }
  if (desc.kind === "intersection") {
    const nominalId = getNominalComponentId(typeId, ctx);
    if (typeof nominalId === "number") {
      const nominalDesc = ctx.program.types.getTypeDesc(nominalId);
      if (nominalDesc.kind === "value-object") {
        const info = getStructuralTypeInfo(typeId, ctx, seen);
        if (!info) {
          throw new Error("missing structural type info for value intersection field");
        }
        return info.runtimeType;
      }
    }
  }
  const structuralId = resolveStructuralTypeId(typeId, ctx);
  if (typeof structuralId === "number") {
    if (isStructurallyRecursive(structuralId, ctx)) {
      return ensureStructuralRuntimeType(structuralId, ctx);
    }
    const info = getStructuralTypeInfo(typeId, ctx, seen);
    if (!info) {
      throw new Error("missing structural type info for heap field");
    }
    return info.runtimeType;
  }
  if (desc.kind === "recursive") {
    // Avoid unfolding arbitrary recursive wrappers for field heap types; if a recursive
    // type doesn't resolve to a structural heap type, treat it conservatively.
    return ctx.rtt.baseType;
  }
  return wasmTypeFor(typeId, ctx, seen, mode);
};

export const getSymbolTypeId = (
  symbol: SymbolId,
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId,
): TypeId => {
  const instanceType =
    typeof instanceId === "number"
      ? ctx.program.functions.getInstanceValueType(instanceId, symbol)
      : undefined;
  const typeId =
    typeof instanceType === "number"
      ? instanceType
      : ctx.module.types.getValueType(symbol);
  if (typeof typeId === "number") {
    return substituteTypeForInstance({ typeId, ctx, instanceId });
  }
  throw new Error(
    `codegen missing type information for symbol ${getLocalSymbolName(
      symbol,
      ctx,
    )} (module ${ctx.moduleId}, symbol ${symbol})`,
  );
};

export const getDeclaredSymbolTypeId = (
  symbol: SymbolId,
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId,
): TypeId => {
  const typeId = ctx.module.types.getValueType(symbol);
  if (typeof typeId === "number") {
    return substituteTypeForInstance({ typeId, ctx, instanceId });
  }
  return getSymbolTypeId(symbol, ctx, instanceId);
};

const getInstanceExprType = (
  exprId: HirExprId,
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId,
): TypeId | undefined => {
  if (typeof instanceId !== "number") {
    return undefined;
  }
  const instanceType = ctx.program.functions.getInstanceExprType(
    instanceId,
    exprId,
  );
  return typeof instanceType === "number" ? instanceType : undefined;
};

function substituteTypeForInstance({
  typeId,
  ctx,
  instanceId,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  instanceId?: ProgramFunctionInstanceId;
}): TypeId {
  const substitution = buildInstanceSubstitution({
    ctx,
    typeInstanceId: instanceId,
  });
  return substitution
    ? ctx.program.types.substitute(typeId, substitution)
    : typeId;
}

export const getRequiredExprType = (
  exprId: HirExprId,
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId,
): TypeId => {
  const instanceType = getInstanceExprType(exprId, ctx, instanceId);
  if (typeof instanceType === "number") {
    return substituteTypeForInstance({ typeId: instanceType, ctx, instanceId });
  }
  const resolved = ctx.module.types.getResolvedExprType(exprId);
  if (typeof resolved === "number") {
    return substituteTypeForInstance({ typeId: resolved, ctx, instanceId });
  }
  const typeId = ctx.module.types.getExprType(exprId);
  if (typeof typeId === "number") {
    return substituteTypeForInstance({ typeId, ctx, instanceId });
  }
  throw new Error(`codegen missing type information for expression ${exprId}`);
};

export const getUnresolvedExprType = (
  exprId: HirExprId,
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId,
): TypeId => {
  const instanceType = getInstanceExprType(exprId, ctx, instanceId);
  if (typeof instanceType === "number") {
    return substituteTypeForInstance({ typeId: instanceType, ctx, instanceId });
  }

  const baseTypeId = ctx.module.types.getExprType(exprId);
  if (typeof baseTypeId === "number") {
    return substituteTypeForInstance({ typeId: baseTypeId, ctx, instanceId });
  }

  throw new Error(`codegen missing type information for expression ${exprId}`);
};

export const getExprBinaryenType = (
  exprId: HirExprId,
  ctx: CodegenContext,
  instanceId?: ProgramFunctionInstanceId,
): binaryen.Type => {
  const instanceType = getInstanceExprType(exprId, ctx, instanceId);
  if (typeof instanceType === "number") {
    const typeId = substituteTypeForInstance({
      typeId: instanceType,
      ctx,
      instanceId,
    });
    return wasmTypeFor(typeId, ctx);
  }
  const resolved = ctx.module.types.getResolvedExprType(exprId);
  const baseTypeId =
    typeof resolved === "number"
      ? resolved
      : ctx.module.types.getExprType(exprId);
  if (typeof baseTypeId === "number") {
    const typeId = substituteTypeForInstance({
      typeId: baseTypeId,
      ctx,
      instanceId,
    });
    return wasmTypeFor(typeId, ctx);
  }
  return binaryen.none;
};

export const getTypeIdFromTypeExpr = (
  expr: HirTypeExpr,
  _ctx: CodegenContext,
): TypeId => {
  if (typeof expr.typeId === "number") {
    return expr.typeId;
  }
  throw new Error("codegen expected type-annotated HIR type expression");
};

export const getMatchPatternTypeId = (
  pattern: HirPattern & { kind: "type" },
  ctx: CodegenContext,
): TypeId => {
  if (typeof pattern.typeId === "number") {
    return pattern.typeId;
  }
  return getTypeIdFromTypeExpr(pattern.type, ctx);
};

export const getStructuralTypeInfo = (
  typeId: TypeId,
  ctx: CodegenContext,
  seen: Set<TypeId> = new Set(),
): StructuralTypeInfo | undefined => {
  const typeDesc = ctx.program.types.getTypeDesc(typeId);
  if (typeDesc.kind === "nominal-object" || typeDesc.kind === "value-object") {
    const info = ctx.program.objects.getInfoByNominal(typeId);
    if (info && info.type !== typeId) {
      return getStructuralTypeInfo(info.type, ctx, seen);
    }
  }
  const structuralId = resolveStructuralTypeId(typeId, ctx);
  if (typeof structuralId !== "number") {
    return undefined;
  }

  const cacheKey = structuralTypeKey(ctx.moduleId, typeId);
  const cached = ctx.structTypes.get(cacheKey);
  if (cached) {
    return cached;
  }

  try {
    const desc = ctx.program.types.getTypeDesc(structuralId);
    if (desc.kind !== "structural-object") {
      return undefined;
    }
    const nominalId = getNominalComponentId(typeId, ctx);
    const objectInfo =
      typeof nominalId === "number"
        ? ctx.program.objects.getInfoByNominal(nominalId)
        : undefined;
    const substitution = (() => {
      if (objectInfo || typeof nominalId !== "number") {
        return undefined;
      }
      const nominalDesc = ctx.program.types.getTypeDesc(nominalId);
      if (
        nominalDesc.kind !== "nominal-object" &&
        nominalDesc.kind !== "value-object"
      ) {
        return undefined;
      }
      const owner = nominalDesc.owner;
      if (typeof owner !== "number") {
        return undefined;
      }
      const template = ctx.program.objects.getTemplate(owner);
      if (!template) {
        return undefined;
      }
      if (template.params.length !== nominalDesc.typeArgs.length) {
        return undefined;
      }
      return new Map(
        template.params.map(
          (param, index) =>
            [param.typeParam, nominalDesc.typeArgs[index]!] as const,
        ),
      );
    })();

    const nominalLayoutDesc =
      typeof nominalId === "number"
        ? ctx.program.types.getTypeDesc(nominalId)
        : undefined;
    const isValueLayout =
      objectInfo?.objectKind === "value" || nominalLayoutDesc?.kind === "value-object";
    const nominalAncestry = getNominalAncestry(nominalId, ctx);
    const nominalAncestors = nominalAncestry.map((entry) => entry.nominalId);
    const typeLabel = makeRuntimeTypeLabel({
      moduleLabel: ctx.moduleLabel,
      typeId,
      structuralId,
      nominalId,
    });
    const runtimeTypeId = runtimeTypeIdFor(typeId, ctx);
    const provisionalInfo =
      !isValueLayout
        ? {
            typeId,
            layoutKind: "heap-object" as const,
            runtimeTypeId,
            structuralId,
            nominalId,
            nominalAncestors,
            runtimeType: ctx.rtt.baseType,
            interfaceType: ctx.rtt.baseType,
            fields: [],
            fieldMap: new Map<string, StructuralFieldInfo>(),
            typeLabel,
          }
        : undefined;
    if (provisionalInfo) {
      ctx.structTypes.set(cacheKey, provisionalInfo);
    }
    let inlineStart = 0;
    let valueRuntimeIndex = 0;
    const fields: StructuralFieldInfo[] = desc.fields.map((field, index) => {
      const fieldSeen = new Set(seen);
      fieldSeen.add(typeId);
      const fieldTypeId =
        substitution &&
        substitution.size > 0 &&
        typeContainsUnresolvedParam({
          typeId: field.type,
          getTypeDesc: (candidate) => ctx.program.types.getTypeDesc(candidate),
        })
          ? ctx.program.types.substitute(field.type, substitution)
          : field.type;
      const wasmType = isValueLayout
        ? wasmTypeFor(fieldTypeId, ctx, fieldSeen, "signature")
        : wasmTypeFor(fieldTypeId, ctx, new Set(), "signature");
      const heapWasmType = isValueLayout
        ? wasmStructFieldTypeFor(fieldTypeId, ctx, fieldSeen)
        : lowerHeapObjectFieldRuntimeType({
            typeId: fieldTypeId,
            ownerStructuralId: structuralId,
            ctx,
          });
      const inlineWasmTypes = expandAbiTypes(wasmType);
      const fieldInfo: StructuralFieldInfo = {
        name: field.name,
        typeId: fieldTypeId,
        wasmType,
        inlineWasmTypes,
        inlineStart,
        inlineArity: inlineWasmTypes.length,
        heapWasmType,
        runtimeIndex: isValueLayout
          ? valueRuntimeIndex
          : index + RTT_METADATA_SLOT_COUNT,
        optional: field.optional,
        hash: 0,
      };
      inlineStart += inlineWasmTypes.length;
      if (isValueLayout) {
        valueRuntimeIndex += inlineWasmTypes.length;
      }
      return fieldInfo;
    });
    const runtimeType = isValueLayout
      ? defineStructType(ctx.mod, {
          name: `${typeLabel}__value`,
          fields: fields.flatMap((field) =>
            field.inlineWasmTypes.map((type, fieldIndex) => ({
              name: `${field.name}_${fieldIndex}`,
              type,
              mutable: true,
            })),
          ),
          supertype: binaryenTypeToHeapType(ctx.rtt.rootType),
          final: true,
        })
      : (() => {
          const cachedRuntime = ctx.structHeapTypes.get(structuralId);
          if (cachedRuntime) {
            return cachedRuntime;
          }
          if (isStructurallyRecursive(structuralId, ctx)) {
            return ensureStructuralRuntimeType(structuralId, ctx);
          }
          const runtime = defineStructType(ctx.mod, {
            name: structuralHeapTypeName(structuralId),
            fields: [
              {
                name: "__ancestors_table",
                type: ctx.rtt.extensionHelpers.i32Array,
                mutable: false,
              },
              {
                name: "__field_index_table",
                type: ctx.rtt.fieldLookupHelpers.lookupTableType,
                mutable: false,
              },
              {
                name: "__method_lookup_table",
                type: ctx.rtt.methodLookupHelpers.lookupTableType,
                mutable: false,
              },
              ...fields.map((field) => ({
                name: field.name,
                type: field.heapWasmType,
                mutable: true,
              })),
            ],
            supertype: binaryenTypeToHeapType(ctx.rtt.baseType),
            final: true,
          });
          ctx.structHeapTypes.set(structuralId, runtime);
          return runtime;
        })();
    const info: StructuralTypeInfo = provisionalInfo ?? {
      typeId,
      layoutKind: "value-object",
      runtimeTypeId,
      structuralId,
      nominalId,
      nominalAncestors,
      runtimeType,
      interfaceType: abiTypeFor(fields.flatMap((field) => field.inlineWasmTypes)),
      fields: [],
      fieldMap: new Map<string, StructuralFieldInfo>(),
      typeLabel,
    };
    info.runtimeType = runtimeType;
    info.interfaceType = isValueLayout
      ? abiTypeFor(fields.flatMap((field) => field.inlineWasmTypes))
      : ctx.rtt.baseType;
    info.fields = fields;
    info.fieldMap = new Map(fields.map((field) => [field.name, field]));
    ctx.structTypes.set(cacheKey, info);

    if (!isValueLayout) {
      info.ancestorsGlobal = `__ancestors_table_${typeLabel}`;
      info.fieldTableGlobal = `__field_index_table_${typeLabel}`;
      info.methodTableGlobal = `__method_table_${typeLabel}`;
      const structMetadataState =
        ctx.programHelpers.getHelperState<StructMetadataState>(
          STRUCT_METADATA_STATE,
          () => ({ registered: new Set<string>() }),
        );
      const registered = structMetadataState.registered ?? new Set<string>();
      structMetadataState.registered = registered;
      if (!registered.has(typeLabel)) {
        registered.add(typeLabel);
        const ancestors = buildRuntimeAncestors({
          typeId,
          structuralId,
          nominalAncestry,
          ctx,
        });
        const fieldTableExpr = ctx.rtt.fieldLookupHelpers.registerType({
          typeLabel,
          runtimeType,
          baseType: ctx.rtt.baseType,
          fields,
        });
        const methodEntries = createMethodLookupEntries({
          impls:
            typeof nominalId === "number"
              ? instantiateTraitImplsForNominal({ nominal: nominalId, ctx })
              : [],
          ctx,
          typeLabel,
          runtimeType,
        });
        const methodTableExpr =
          ctx.rtt.methodLookupHelpers.createTable(methodEntries);

        ctx.mod.addGlobal(
          info.ancestorsGlobal,
          ctx.rtt.extensionHelpers.i32Array,
          false,
          ctx.rtt.extensionHelpers.initExtensionArray(ancestors),
        );
        ctx.mod.addGlobal(
          info.fieldTableGlobal,
          ctx.rtt.fieldLookupHelpers.lookupTableType,
          false,
          fieldTableExpr,
        );
        ctx.mod.addGlobal(
          info.methodTableGlobal,
          ctx.rtt.methodLookupHelpers.lookupTableType,
          false,
          methodTableExpr,
        );
      }
    }

    return info;
  } catch (error) {
    ctx.structTypes.delete(cacheKey);
    throw error;
  } finally {
  }
};

export const resolveStructuralTypeId = (
  typeId: TypeId,
  ctx: CodegenContext,
): TypeId | undefined => {
  const cached = ctx.structuralIdCache.get(typeId);
  if (cached !== undefined || ctx.structuralIdCache.has(typeId)) {
    return cached ?? undefined;
  }
  if (ctx.resolvingStructuralIds.has(typeId)) {
    return undefined;
  }
  ctx.resolvingStructuralIds.add(typeId);

  const desc = ctx.program.types.getTypeDesc(typeId);
  try {
    const resolved = (() => {
      if (desc.kind === "recursive") {
        const unfolded = ctx.program.types.substitute(
          desc.body,
          new Map([[desc.binder, typeId]]),
        );
        return resolveStructuralTypeId(unfolded, ctx);
      }
      if (desc.kind === "structural-object") {
        return typeId;
      }
      if (desc.kind === "nominal-object" || desc.kind === "value-object") {
        const info = ctx.program.objects.getInfoByNominal(typeId);
        if (info) {
          return info.structural;
        }
        const owner = desc.owner;
        if (typeof owner !== "number") {
          return undefined;
        }
        const template = ctx.program.objects.getTemplate(owner);
        if (!template) {
          return undefined;
        }
        if (template.params.length !== desc.typeArgs.length) {
          return undefined;
        }
        const substitution = new Map(
          template.params.map(
            (param, index) => [param.typeParam, desc.typeArgs[index]!] as const,
          ),
        );
        return ctx.program.types.substitute(template.structural, substitution);
      }
      if (desc.kind === "intersection" && typeof desc.structural === "number") {
        return desc.structural;
      }
      return undefined;
    })();

    ctx.structuralIdCache.set(
      typeId,
      typeof resolved === "number" ? resolved : null,
    );
    return resolved;
  } finally {
    ctx.resolvingStructuralIds.delete(typeId);
  }
};

const makeRuntimeTypeLabel = ({
  moduleLabel,
  typeId,
  structuralId,
  nominalId,
}: {
  moduleLabel: string;
  typeId: TypeId;
  structuralId: TypeId;
  nominalId?: TypeId;
}): string => {
  const nominalPrefix =
    typeof nominalId === "number" ? `nominal_${nominalId}_` : "";
  return `${moduleLabel}__struct_${nominalPrefix}type_${typeId}_shape_${structuralId}`;
};

const isUnknownPrimitive = (typeId: TypeId, ctx: CodegenContext): boolean => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  return desc.kind === "primitive" && desc.name === "unknown";
};

const buildRuntimeAncestors = ({
  typeId,
  structuralId,
  nominalAncestry,
  ctx,
}: {
  typeId: TypeId;
  structuralId: TypeId;
  nominalAncestry: readonly { nominalId: TypeId; typeId: TypeId }[];
  ctx: CodegenContext;
}): number[] => {
  const runtimeIdMemo = new Map<TypeId, number>();
  const runtimeIdFor = (id: TypeId): number => {
    const cached = runtimeIdMemo.get(id);
    if (cached !== undefined) {
      return cached;
    }
    const computed = runtimeTypeIdFor(id, ctx);
    runtimeIdMemo.set(id, computed);
    return computed;
  };

  const seen = new Set<number>();
  const ancestors: number[] = [];
  const add = (id?: TypeId) => {
    if (typeof id !== "number") {
      return;
    }
    const runtimeId = runtimeIdFor(id);
    if (seen.has(runtimeId)) {
      return;
    }
    seen.add(runtimeId);
    ancestors.push(runtimeId);
  };

  add(typeId);
  nominalAncestry.forEach((entry) => {
    add(entry.typeId);
    add(entry.nominalId);
  });
  add(structuralId);

  const addCompatibleSuperInstantiations = (nominalId?: TypeId) => {
    if (typeof nominalId !== "number") {
      return;
    }
    const sourceDesc = ctx.program.types.getTypeDesc(nominalId);
    if (
      sourceDesc.kind !== "nominal-object" ||
      sourceDesc.typeArgs.some((arg) => isUnknownPrimitive(arg, ctx))
    ) {
      return;
    }

    const candidates = ctx.program.objects.getNominalInstancesByOwner(
      sourceDesc.owner,
    );

    candidates.forEach((candidateNominal) => {
      if (candidateNominal === nominalId) {
        return;
      }
      const info = ctx.program.objects.getInfoByNominal(candidateNominal);
      if (!info || info.nominal !== candidateNominal) {
        return;
      }
      const targetDesc = ctx.program.types.getTypeDesc(candidateNominal);
      if (
        targetDesc.kind !== "nominal-object" ||
        targetDesc.typeArgs.length !== sourceDesc.typeArgs.length ||
        targetDesc.typeArgs.some((arg) => isUnknownPrimitive(arg, ctx))
      ) {
        return;
      }

      const compatible = sourceDesc.typeArgs.every((arg, index) => {
        const targetArg = targetDesc.typeArgs[index]!;
        const forward = ctx.program.types.unify(arg, targetArg, {
          location: ctx.module.hir.module.ast,
          reason: "nominal instantiation compatibility",
          variance: "covariant",
        });
        return forward.ok;
      });

      if (compatible) {
        add(info.type);
        add(candidateNominal);
      }
    });
  };

  addCompatibleSuperInstantiations(nominalAncestry[0]?.nominalId);

  return ancestors;
};

const instantiateTraitImplsForNominal = ({
  nominal,
  ctx,
}: {
  nominal: TypeId;
  ctx: CodegenContext;
}): readonly CodegenTraitImplInstance[] => {
  const existing = ctx.program.traits.getImplsByNominal(nominal);
  if (existing.length > 0) {
    return existing;
  }

  const nominalDesc = ctx.program.types.getTypeDesc(nominal);
  if (nominalDesc.kind !== "nominal-object") {
    return [];
  }

  const templates = ctx.program.traits.getImplTemplates();
  if (templates.length === 0) {
    return [];
  }

  const instances = templates.flatMap((template) => {
    const match = ctx.program.types.unify(nominal, template.target, {
      location: ctx.module.hir.module.ast,
      reason: "codegen trait impl instantiation",
      variance: "invariant",
    });
    if (!match.ok) {
      return [];
    }
    const trait = ctx.program.types.substitute(
      template.trait,
      match.substitution,
    );
    const target = ctx.program.types.substitute(
      template.target,
      match.substitution,
    );
    return [
      {
        trait,
        traitSymbol: template.traitSymbol,
        target,
        methods: template.methods.map(({ traitMethod, implMethod }) => ({
          traitMethod,
          implMethod,
        })),
        implSymbol: template.implSymbol,
      },
    ] satisfies readonly CodegenTraitImplInstance[];
  });

  const seen = new Set<ProgramSymbolId>();
  return instances.filter((impl) => {
    if (seen.has(impl.implSymbol)) {
      return false;
    }
    seen.add(impl.implSymbol);
    return true;
  });
};

const describeTraitImplMetadataInstances = ({
  metas,
  runtimeType,
}: {
  metas: readonly FunctionMetadata[];
  runtimeType: binaryen.Type;
}): string =>
  metas
    .map((entry) => {
      const receiverTypeIndex = entry.effectful
        ? Math.max(0, entry.paramTypes.length - entry.paramTypeIds.length)
        : 0;
      const receiverType = entry.paramTypes[receiverTypeIndex] ?? runtimeType;
      const receiverTypeId = entry.paramTypeIds[0];
      return `${entry.wasmName}#${entry.instanceId}@${receiverType}(receiverTypeId=${receiverTypeId},typeArgs=[${entry.typeArgs.join(",")}])`;
    })
    .join(", ");

const sanitizeIdentifierForWasm = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const symbolNameForModuleSymbol = ({
  moduleId,
  symbol,
  ctx,
}: {
  moduleId: string;
  symbol: SymbolId;
  ctx: CodegenContext;
}): string =>
  ctx.program.symbols.getName(ctx.program.symbols.idOf({ moduleId, symbol })) ??
  `${symbol}`;

const synthesizeConcreteFunctionMeta = ({
  moduleId,
  symbol,
  ctx,
}: {
  moduleId: string;
  symbol: SymbolId;
  ctx: CodegenContext;
}): FunctionMetadata | undefined => {
  const moduleView = ctx.program.modules.get(moduleId);
  if (!moduleView) {
    return undefined;
  }
  const functionItem = Array.from(moduleView.hir.items.values()).find(
    (item): item is HirFunction =>
      item.kind === "function" && item.symbol === symbol,
  );
  if (!functionItem) {
    return undefined;
  }

  const signature = ctx.program.functions.getSignature(moduleId, symbol);
  if (!signature) {
    return undefined;
  }
  const scheme = ctx.program.types.getScheme(signature.scheme);

  const effectInfo = moduleView.effectsInfo.functions.get(symbol);
  if (!effectInfo) {
    return undefined;
  }
  const effectful = effectInfo.pure === false;
  const instantiations =
    scheme.params.length === 0
      ? (() => {
          const instanceId = ctx.program.functions.getInstanceId(
            moduleId,
            symbol,
            [],
          );
          return typeof instanceId === "number"
            ? ([[instanceId, []]] as const)
            : ([] as const);
        })()
      : Array.from(
          ctx.program.functions.getInstantiationInfo(moduleId, symbol)?.entries() ??
            [],
        );
  if (instantiations.length === 0) {
    return undefined;
  }

  const bySymbol =
    ctx.functions.get(moduleId) ?? new Map<number, FunctionMetadata[]>();

  for (const [instanceId, typeArgs] of instantiations) {
    const existing = bySymbol.get(symbol) ?? [];
    if (existing.some((entry) => entry.instanceId === instanceId)) {
      continue;
    }

    const reused = ctx.functionInstances.get(instanceId);
    if (reused) {
      bySymbol.set(symbol, [...existing, reused]);
      continue;
    }

    const instantiatedTypeId = ctx.program.types.instantiate(
      signature.scheme,
      typeArgs,
    );
    const instantiatedTypeDesc = ctx.program.types.getTypeDesc(instantiatedTypeId);
    if (instantiatedTypeDesc.kind !== "function") {
      return;
    }

    const paramAbiKinds = instantiatedTypeDesc.parameters.map((param, index) =>
      getOptimizedParamAbiKind({
        typeId: param.type,
        bindingKind: signature.parameters[index]?.bindingKind,
        ctx,
      }),
    );
    const paramAbiTypes = instantiatedTypeDesc.parameters.map((param, index) =>
      getOptimizedAbiTypesForParam({
        typeId: param.type,
        bindingKind: signature.parameters[index]?.bindingKind,
        ctx,
      }),
    );
    const userParamTypes = paramAbiTypes.flat();
    const resultAbiKind =
      effectful
        ? "direct"
        : getOptimizedResultAbiKind({
            typeId: instantiatedTypeDesc.returnType,
            ctx,
          });
    const outParamType =
      resultAbiKind === "out_ref"
        ? getOptimizedAbiTypeForResult({
            typeId: instantiatedTypeDesc.returnType,
            ctx,
          })
        : undefined;
    const resultAbiTypes =
      resultAbiKind === "direct"
        ? getAbiTypesForSignature(instantiatedTypeDesc.returnType, ctx)
        : [];
    const widened = ctx.effectsBackend.abi.widenSignature({
      ctx,
      effectful,
      userParamTypes: outParamType ? [outParamType, ...userParamTypes] : userParamTypes,
      userResultType:
        resultAbiKind === "out_ref"
          ? binaryen.none
          : getSignatureWasmType(instantiatedTypeDesc.returnType, ctx),
    });

    const metadata: FunctionMetadata = {
      moduleId,
      symbol,
      wasmName:
        `${sanitizeIdentifierForWasm(moduleView.hir.module.path)}__` +
        `${sanitizeIdentifierForWasm(
          symbolNameForModuleSymbol({ moduleId, symbol, ctx }),
        )}_${symbol}` +
        (typeArgs.length === 0
          ? ""
          : `__inst_${sanitizeIdentifierForWasm(typeArgs.join("_"))}`),
      paramTypes: widened.paramTypes,
      paramAbiTypes,
      userParamOffset: widened.userParamOffset,
      firstUserParamIndex:
        widened.userParamOffset + (outParamType ? 1 : 0),
      resultType: widened.resultType,
      resultAbiTypes,
      paramTypeIds: instantiatedTypeDesc.parameters.map((param) => param.type),
      parameters: instantiatedTypeDesc.parameters.map((param, index) => ({
        typeId: param.type,
        label: param.label,
        optional: param.optional,
        name:
          typeof functionItem.parameters[index]?.symbol === "number"
            ? symbolNameForModuleSymbol({
                moduleId,
                symbol: functionItem.parameters[index]!.symbol,
                ctx,
              })
            : undefined,
        bindingKind: signature.parameters[index]?.bindingKind,
      })),
      paramAbiKinds,
      resultTypeId: instantiatedTypeDesc.returnType,
      resultAbiKind,
      outParamType,
      typeArgs,
      instanceId,
      effectful,
      effectRow: effectInfo.effectRow,
    };

    bySymbol.set(symbol, [...existing, metadata]);
    ctx.functionInstances.set(instanceId, metadata);
  }

  if (bySymbol.size > 0) {
    ctx.functions.set(moduleId, bySymbol);
  }
  return bySymbol.get(symbol)?.[0];
};

const resolveTraitImplMethodMeta = ({
  metas,
  impl,
  implRef,
  traitMethod,
  runtimeType,
  ctx,
}: {
  metas: readonly FunctionMetadata[] | undefined;
  impl: CodegenTraitImplInstance;
  implRef: { moduleId: string; symbol: SymbolId };
  traitMethod: SymbolId;
  runtimeType: binaryen.Type;
  ctx: CodegenContext;
}): FunctionMetadata | undefined => {
  const canonicalImplMethodId = ctx.program.symbols.canonicalIdOf(
    implRef.moduleId,
    implRef.symbol,
  );
  const intrinsicFlags =
    ctx.program.symbols.getIntrinsicFunctionFlags(canonicalImplMethodId);
  if (
    intrinsicFlags.intrinsic &&
    intrinsicFlags.intrinsicUsesSignature !== true
  ) {
    return undefined;
  }

  const knownMetas =
    metas && metas.length > 0
      ? metas
      : (() => {
          const registrationState =
            ctx.programHelpers.getHelperState<FunctionMetadataRegistrationState>(
              FUNCTION_METADATA_REGISTRATION_STATE,
              () => ({ active: false }),
            );
          if (registrationState.active) {
            return metas;
          }
          const synthesized = synthesizeConcreteFunctionMeta({
            moduleId: implRef.moduleId,
            symbol: implRef.symbol,
            ctx,
          });
          if (!synthesized) {
            return metas;
          }
          return ctx.functions.get(implRef.moduleId)?.get(implRef.symbol);
        })();

  const pickPreferredMeta = (
    candidates: readonly FunctionMetadata[] | undefined,
  ): FunctionMetadata | undefined => {
    if (!candidates || candidates.length === 0) {
      return undefined;
    }
    return (
      candidates.find((candidate) => {
        const receiverTypeIndex = candidate.firstUserParamIndex;
        return candidate.paramTypes[receiverTypeIndex] === runtimeType;
      }) ?? candidates[0]
    );
  };

  const receiverMatches = ({
    receiverTypeId,
    expectedTypeId,
  }: {
    receiverTypeId: TypeId | undefined;
    expectedTypeId: TypeId;
  }): boolean =>
    typeof receiverTypeId === "number" &&
    ctx.program.types.unify(receiverTypeId, expectedTypeId, {
      location: ctx.module.hir.module.ast,
      reason: "trait method metadata selection",
      variance: "invariant",
    }).ok;

  const exactTargetMeta = pickPreferredMeta(
    knownMetas?.filter((candidate) => candidate.paramTypeIds[0] === impl.target),
  );
  if (exactTargetMeta) {
    return exactTargetMeta;
  }

  const invariantTargetMeta = pickPreferredMeta(
    knownMetas?.filter((candidate) =>
      receiverMatches({
        receiverTypeId: candidate.paramTypeIds[0],
        expectedTypeId: impl.target,
      }),
    ),
  );
  if (invariantTargetMeta) {
    return invariantTargetMeta;
  }

  const meta = pickTraitImplMethodMeta({
    metas: knownMetas,
    impl,
    runtimeType,
    ctx,
  });
  if (meta) {
    return meta;
  }

  const signature = ctx.program.functions.getSignature(
    implRef.moduleId,
    implRef.symbol,
  );
  const scheme = signature
    ? ctx.program.types.getScheme(signature.scheme)
    : undefined;
  const signatureTypeParamCount = signature?.typeParams?.length ?? 0;
  const schemeTypeParamCount = scheme?.params.length ?? 0;
  const unresolvedImplTarget = typeContainsUnresolvedParam({
    typeId: impl.target,
    getTypeDesc: (typeId) => ctx.program.types.getTypeDesc(typeId),
  });
  const unresolvedImplTrait = typeContainsUnresolvedParam({
    typeId: impl.trait,
    getTypeDesc: (typeId) => ctx.program.types.getTypeDesc(typeId),
  });

  if (
    signatureTypeParamCount > 0 ||
    schemeTypeParamCount > 0 ||
    unresolvedImplTarget ||
    unresolvedImplTrait
  ) {
    // Keep generic/unresolved entries out of concrete runtime dispatch tables.
    return undefined;
  }

  const availableInstances = describeTraitImplMetadataInstances({
    metas: knownMetas ?? [],
    runtimeType,
  });
  const moduleView = ctx.program.modules.get(implRef.moduleId);
  const hasFunctionItem = Boolean(
    moduleView &&
      Array.from(moduleView.hir.items.values()).some(
        (item) => item.kind === "function" && item.symbol === implRef.symbol,
      ),
  );
  throw new Error(
    [
      "codegen missing metadata for trait method impl",
      `impl: ${implRef.moduleId}::${implRef.symbol}`,
      `trait method: ${impl.traitSymbol}:${traitMethod}`,
      `runtime type: ${runtimeType}`,
      `impl target: ${impl.target}`,
      `impl trait: ${impl.trait}`,
      `impl has function item: ${hasFunctionItem}`,
      `available instances: ${availableInstances || "<none>"}`,
    ].join("\n"),
  );
};

const createMethodLookupEntries = ({
  impls,
  ctx,
  typeLabel,
  runtimeType,
}: {
  impls: readonly CodegenTraitImplInstance[];
  ctx: CodegenContext;
  typeLabel: string;
  runtimeType: binaryen.Type;
}): MethodAccessorEntry[] => {
  if (impls.length === 0) {
    return [];
  }
  const entries: MethodAccessorEntry[] = [];
  const hashes = new Map<number, string>();
  const dispatchEffectfulBySignature = new Map<string, boolean>();

  impls.forEach((impl) => {
    impl.methods.forEach(({ traitMethod, implMethod }) => {
      const implRef = ctx.program.symbols.refOf(implMethod as ProgramSymbolId);
      const traitMethodImpl = ctx.program.traits.getTraitMethodImpl(
        implMethod as ProgramSymbolId,
      );
      const hashTraitSymbol = traitMethodImpl?.traitSymbol ?? impl.traitSymbol;
      const hashTraitMethod = traitMethodImpl?.traitMethodSymbol ?? traitMethod;
      const resolvedImplRef = resolveImportedFunctionSymbol({
        ctx,
        moduleId: implRef.moduleId,
        symbol: implRef.symbol,
      });
      const metas = ctx.functions
        .get(resolvedImplRef.moduleId)
        ?.get(resolvedImplRef.symbol);
      const meta = resolveTraitImplMethodMeta({
        metas,
        impl,
        implRef: resolvedImplRef,
        traitMethod,
        runtimeType,
        ctx,
      });
      if (!meta) {
        return;
      }
      markReachableFunctionSymbol({
        ctx,
        moduleId: meta.moduleId,
        symbol: meta.symbol,
      });
      if (!meta.wasmName) {
        throw new Error(
          `codegen missing wasm symbol for trait method impl ${implRef.moduleId}::${implRef.symbol}`,
        );
      }
      if (meta.paramTypes.length === 0) {
        throw new Error(
          `codegen missing receiver parameter type for trait method impl ${implRef.moduleId}::${implRef.symbol}`,
        );
      }
      const receiverTypeIndex = meta.firstUserParamIndex;
      const receiverType = meta.paramTypes[receiverTypeIndex];
      if (typeof receiverType !== "number") {
        throw new Error(
          `codegen missing receiver wasm type for trait method impl ${implRef.moduleId}::${implRef.symbol}`,
        );
      }
      const userParamTypes = meta.paramTypes.slice(receiverTypeIndex + 1);
      if (
        meta.effectful &&
        userParamTypes.length + meta.firstUserParamIndex + 1 !== meta.paramTypes.length
      ) {
        throw new Error(
          `codegen malformed effectful parameter metadata for trait method impl ${implRef.moduleId}::${implRef.symbol}`,
        );
      }
      if (
        !meta.effectful &&
        userParamTypes.length + meta.firstUserParamIndex + 1 !== meta.paramTypes.length
      ) {
        throw new Error(
          `codegen malformed parameter metadata for trait method impl ${implRef.moduleId}::${implRef.symbol}`,
        );
      }
      const dispatchSignatureKey = traitDispatchSignatureKey({
        traitSymbol: hashTraitSymbol,
        traitMethodSymbol: hashTraitMethod,
      });
      if (
        ctx.optimization &&
        !ctx.optimization.usedTraitDispatchSignatures.has(dispatchSignatureKey)
      ) {
        return;
      }
      const dispatchEffectful =
        dispatchEffectfulBySignature.get(dispatchSignatureKey) ??
        (() => {
          const value = isTraitDispatchMethodEffectful({
            traitSymbol: hashTraitSymbol,
            traitMethodSymbol: hashTraitMethod,
            ctx,
          });
          dispatchEffectfulBySignature.set(dispatchSignatureKey, value);
          return value;
        })();
      if (!dispatchEffectful && meta.effectful) {
        throw new Error(
          [
            "trait dispatch ABI mismatch",
            `type: ${typeLabel}`,
            `trait method: ${hashTraitSymbol}:${hashTraitMethod}`,
            `impl: ${implRef.moduleId}::${implRef.symbol}`,
            "dispatch requires pure ABI but impl lowered as effectful",
          ].join("\n"),
        );
      }
      const handlerParamType = ctx.effectsBackend.abi.hiddenHandlerParamType(ctx);
      const outParamTypes =
        meta.resultAbiKind === "out_ref" && typeof meta.outParamType === "number"
          ? [meta.outParamType]
          : [];
      const params = dispatchEffectful
        ? [handlerParamType, ...outParamTypes, ctx.rtt.baseType, ...userParamTypes]
        : [...outParamTypes, ctx.rtt.baseType, ...userParamTypes];
      const receiverParamIndex =
        (dispatchEffectful ? 1 : 0) + outParamTypes.length;
      const firstUserParamIndex = receiverParamIndex + 1;
      const implCall = ctx.mod.call(
        meta.wasmName,
        [
          ...(meta.effectful
            ? [ctx.mod.local.get(0, handlerParamType)]
            : []),
          ...(outParamTypes.length > 0
            ? [ctx.mod.local.get(dispatchEffectful ? 1 : 0, outParamTypes[0]!)]
            : []),
          refCast(
            ctx.mod,
            ctx.mod.local.get(receiverParamIndex, ctx.rtt.baseType),
            receiverType,
          ),
          ...userParamTypes.map((type, index) =>
            ctx.mod.local.get(index + firstUserParamIndex, type),
          ),
        ],
        meta.resultType,
      );
      const wrapperResultType = dispatchEffectful
        ? ctx.effectsBackend.abi.effectfulResultType(ctx)
        : meta.resultAbiKind === "out_ref"
          ? binaryen.none
          : meta.resultType;
      const wrapperName = `${typeLabel}__method_${hashTraitSymbol}_${hashTraitMethod}_${implRef.symbol}`;
      const wrapperLocals: binaryen.Type[] = [];
      const wrapperParamType = binaryen.createType(params as number[]);
      const wrapperScratch = {
        locals: wrapperLocals,
        nextLocalIndex: binaryen.expandType(wrapperParamType).length,
      };
      const wrapper = ctx.mod.addFunction(
        wrapperName,
        wrapperParamType,
        wrapperResultType,
        wrapperLocals,
        dispatchEffectful && !meta.effectful
          ? wrapValueInOutcome({
              valueExpr: implCall,
              valueType: meta.resultType,
              ctx,
              fnCtx: wrapperScratch,
            })
          : implCall,
      );
      const heapType = bin._BinaryenFunctionGetType(wrapper);
      const fnType = bin._BinaryenTypeFromHeapType(heapType, false);
      const hash = traitDispatchHash({
        traitSymbol: hashTraitSymbol,
        traitMethodSymbol: hashTraitMethod,
      });
      const signatureKey = traitDispatchSignatureKey({
        traitSymbol: hashTraitSymbol,
        traitMethodSymbol: hashTraitMethod,
      });
      const existing = hashes.get(hash);
      if (existing && existing !== signatureKey) {
        throw new Error(
          [
            `method hash collision detected for ${typeLabel}`,
            `hash: ${hash}`,
            `existing: ${existing}`,
            `new: ${signatureKey}`,
          ].join("\n"),
        );
      }
      hashes.set(hash, signatureKey);
      entries.push({
        hash,
        ref: refFunc(ctx.mod, wrapperName, fnType),
      });
    });
  });

  return entries;
};

const structuralTypeKey = (_moduleId: string, typeId: TypeId): string =>
  `${typeId}`;

const getNominalAncestry = (
  nominalId: TypeId | undefined,
  ctx: CodegenContext,
): readonly { nominalId: TypeId; typeId: TypeId }[] =>
  typeof nominalId === "number"
    ? ctx.program.types.getNominalAncestry(nominalId)
    : [];

const getNominalComponentId = (
  typeId: TypeId,
  ctx: CodegenContext,
): TypeId | undefined => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "recursive") {
    const unfolded = ctx.program.types.substitute(
      desc.body,
      new Map([[desc.binder, typeId]]),
    );
    return getNominalComponentId(unfolded, ctx);
  }
  if (desc.kind === "nominal-object" || desc.kind === "value-object") {
    return typeId;
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    return desc.nominal;
  }
  return undefined;
};

// Symbol/name resolution for nominal owners is handled by `ctx.program.symbols`.
