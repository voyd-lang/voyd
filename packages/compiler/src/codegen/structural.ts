import binaryen from "binaryen";
import {
  arrayGet,
  arrayLen,
  arrayNew,
  arraySet,
  callRef,
  defineStructType,
  initStruct,
  binaryenTypeToHeapType,
  refCast,
  refFunc,
  structGetFieldValue,
  structSetFieldValue,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import { LOOKUP_FIELD_ACCESSOR, RTT_METADATA_SLOTS } from "./rtt/index.js";
import type {
  CodegenContext,
  StructuralFieldInfo,
  FunctionContext,
  StructuralTypeInfo,
  TypeId,
} from "./context.js";
import { allocateTempLocal, loadLocalValue, storeLocalValue } from "./locals.js";
import {
  abiTypeFor,
  getClosureTypeInfo,
  getDirectAbiTypesForSignature,
  getInlineHeapBoxType,
  getInlineUnionLayout,
  getOptionalLayoutInfo,
  getStructuralTypeInfo,
  shouldInlineUnionLayout,
  wasmHeapFieldTypeFor,
  wasmTypeFor,
} from "./types.js";
import { wrapValueInOutcome } from "./effects/outcome-values.js";
import { coerceExprToWasmType } from "./wasm-type-coercions.js";
import { findSerializerForType, serializerKeyFor } from "./serializer.js";
import { captureMultivalueLanes } from "./multivalue.js";

const NON_REF_TYPES = new Set<number>([
  binaryen.none,
  binaryen.unreachable,
  binaryen.i32,
  binaryen.i64,
  binaryen.f32,
  binaryen.f64,
]);

const STRUCTURAL_MATCH_CACHE = Symbol("voyd.codegen.structuralMatchCache");

type StructuralMatchCache = {
  fieldTypes: Map<string, boolean>;
  layouts: Map<string, boolean>;
  conversions: Map<string, boolean>;
};

const structuralMatchCache = (ctx: CodegenContext): StructuralMatchCache =>
  ctx.programHelpers.getHelperState(STRUCTURAL_MATCH_CACHE, () => ({
    fieldTypes: new Map(),
    layouts: new Map(),
    conversions: new Map(),
  }));

const symmetricTypePairKey = (left: TypeId, right: TypeId): string =>
  left <= right ? `${left}:${right}` : `${right}:${left}`;

const defaultValueForWasmType = (
  wasmType: binaryen.Type,
  ctx: CodegenContext,
): binaryen.ExpressionRef => {
  if (wasmType === binaryen.i32) return ctx.mod.i32.const(0);
  if (wasmType === binaryen.i64) return ctx.mod.i64.const(0, 0);
  if (wasmType === binaryen.f32) return ctx.mod.f32.const(0);
  if (wasmType === binaryen.f64) return ctx.mod.f64.const(0);
  return ctx.mod.ref.null(wasmType);
};

const expandAbiTypes = (type: binaryen.Type): binaryen.Type[] =>
  type === binaryen.none ? [] : [...binaryen.expandType(type)];

const makeInlineValue = ({
  values,
  ctx,
}: {
  values: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (values.length === 0) {
    return ctx.mod.nop();
  }
  if (values.length === 1) {
    return values[0]!;
  }
  return ctx.mod.tuple.make(values as binaryen.ExpressionRef[]);
};

const captureAbiValue = ({
  value,
  abiTypes,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  abiTypes: readonly binaryen.Type[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): {
  setup: readonly binaryen.ExpressionRef[];
  lanes: readonly binaryen.ExpressionRef[];
} => {
  if (abiTypes.length <= 1) {
    return {
      setup: [],
      lanes: abiTypes.length === 0 ? [] : [value],
    };
  }

  return captureMultivalueLanes({
    value,
    abiTypes,
    ctx,
    fnCtx,
  });
};

const extractAbiLane = ({
  value,
  abiTypes,
  index,
  ctx,
}: {
  value: binaryen.ExpressionRef;
  abiTypes: readonly binaryen.Type[];
  index: number;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (abiTypes.length === 1) {
    return value;
  }
  return ctx.mod.tuple.extract(value, index);
};

const emitInlineFieldValue = ({
  value,
  field,
  storageBoxType,
  ctx,
}: {
  value: binaryen.ExpressionRef;
  field: StructuralFieldInfo;
  storageBoxType?: binaryen.Type;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (field.inlineWasmTypes.length === 0) {
    return ctx.mod.nop();
  }
  if (typeof storageBoxType === "number") {
    if (field.inlineWasmTypes.length === 1) {
      return structGetFieldValue({
        mod: ctx.mod,
        fieldIndex: field.runtimeIndex,
        fieldType: field.heapWasmType,
        exprRef: refCast(ctx.mod, value, storageBoxType),
      });
    }
    const lanes = field.inlineWasmTypes.map((laneType, index) =>
      structGetFieldValue({
        mod: ctx.mod,
        fieldIndex: field.runtimeIndex + index,
        fieldType: laneType,
        exprRef: refCast(ctx.mod, value, storageBoxType),
      }),
    );
    return makeInlineValue({ values: lanes, ctx });
  }
  const valueAbiTypes = expandAbiTypes(binaryen.getExpressionType(value));
  if (field.inlineWasmTypes.length === 1) {
    return valueAbiTypes.length === 1
      ? value
      : ctx.mod.tuple.extract(value, field.inlineStart);
  }
  const lanes = field.inlineWasmTypes.map((_, index) =>
    ctx.mod.tuple.extract(value, field.inlineStart + index),
  );
  return makeInlineValue({ values: lanes, ctx });
};

const buildInlineUnionBoxFromLanes = ({
  layout,
  memberLayout,
  unionBoxType,
  setup,
  lanes,
  ctx,
}: {
  layout: ReturnType<typeof getInlineUnionLayout>;
  memberLayout: ReturnType<typeof getInlineUnionLayout>["members"][number];
  unionBoxType: binaryen.Type;
  setup: readonly binaryen.ExpressionRef[];
  lanes: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const values = layout.abiTypes.map((abiType, index) => {
    if (index === 0) {
      return ctx.mod.i32.const(memberLayout.tag);
    }
    const memberIndex = index - memberLayout.abiStart;
    if (
      memberIndex >= 0 &&
      memberIndex < memberLayout.abiTypes.length &&
      memberLayout.abiStart + memberIndex === index
    ) {
      return lanes[memberIndex]!;
    }
    return defaultValueForWasmType(abiType, ctx);
  });
  const boxed = initStruct(ctx.mod, unionBoxType, values);
  if (setup.length === 0) {
    return boxed;
  }
  return ctx.mod.block(null, [...setup, boxed], unionBoxType);
};

const captureHeapUnionMemberLanes = ({
  value,
  memberLayout,
  memberInfo,
  ctx,
  fnCtx,
}: {
  value: () => binaryen.ExpressionRef;
  memberLayout: ReturnType<typeof getInlineUnionLayout>["members"][number];
  memberInfo: StructuralTypeInfo;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): {
  setup: readonly binaryen.ExpressionRef[];
  lanes: readonly binaryen.ExpressionRef[];
} => {
  if (memberLayout.abiTypes.length === 0) {
    return { setup: [], lanes: [] };
  }

  const directType = wasmTypeFor(memberLayout.typeId, ctx);
  const layoutType = abiTypeFor(memberLayout.abiTypes);
  if (directType === layoutType) {
    return captureAbiValue({
      value: coerceExprToWasmType({
        expr: value(),
        targetType: layoutType,
        ctx,
      }),
      abiTypes: memberLayout.abiTypes,
      ctx,
      fnCtx,
    });
  }

  const capturedFields = memberInfo.fields.map((field) => {
    const fieldValue = loadStructuralField({
      structInfo: memberInfo,
      field,
      pointer: value,
      ctx,
    });
    const abiTypes = expandAbiTypes(binaryen.getExpressionType(fieldValue));
    return captureAbiValue({
      value: fieldValue,
      abiTypes,
      ctx,
      fnCtx,
    });
  });
  const setup = capturedFields.flatMap((entry) => entry.setup);
  const lanes = capturedFields.flatMap((entry) => entry.lanes);
  if (lanes.length !== memberLayout.abiTypes.length) {
    throw new Error(
      `heap union member ABI mismatch for ${memberLayout.typeId}: expected ${memberLayout.abiTypes.length}, got ${lanes.length}`,
    );
  }
  return { setup, lanes };
};

const materializeHeapUnionMemberValue = ({
  value,
  memberLayout,
  memberInfo,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  memberLayout: ReturnType<typeof getInlineUnionLayout>["members"][number];
  memberInfo: StructuralTypeInfo;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const captured = captureAbiValue({
    value,
    abiTypes: memberLayout.abiTypes,
    ctx,
    fnCtx,
  });
  let laneIndex = 0;
  const fieldValues = memberInfo.fields.map((field) => {
    const inlineFieldValue = makeInlineValue({
      values: field.inlineWasmTypes.map(() => {
        const lane = captured.lanes[laneIndex];
        laneIndex += 1;
        if (!lane) {
          throw new Error(
            `missing lane ${laneIndex - 1} while materializing heap union member ${memberLayout.typeId}`,
          );
        }
        return lane;
      }),
      ctx,
    });
    return lowerValueForHeapField({
      value: inlineFieldValue,
      typeId: field.typeId,
      targetType: field.heapWasmType,
      ctx,
      fnCtx,
    });
  });
  if (laneIndex !== memberLayout.abiTypes.length) {
    throw new Error(
      `heap union member reconstruction mismatch for ${memberLayout.typeId}: expected ${memberLayout.abiTypes.length}, used ${laneIndex}`,
    );
  }
  const materialized = initStructuralValue({
    structInfo: memberInfo,
    fieldValues,
    ctx,
  });
  if (captured.setup.length === 0) {
    return materialized;
  }
  return ctx.mod.block(
    null,
    [...captured.setup, materialized],
    memberInfo.interfaceType,
  );
};

const boxRefLikeUnionValue = ({
  value,
  unionBoxType,
  layout,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  unionBoxType: binaryen.Type;
  layout: ReturnType<typeof getInlineUnionLayout>;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef | undefined => {
  const valueType = binaryen.getExpressionType(value);
  const isRefLike =
    binaryen.expandType(valueType).length === 1 && !NON_REF_TYPES.has(valueType);
  if (!isRefLike) {
    return undefined;
  }

  const exactMember = layout.members.find(
    (member) => getInlineHeapBoxType({ typeId: member.typeId, ctx }) === valueType,
  );
  if (exactMember) {
    const captured = captureAbiValue({
      value: liftHeapValueToInline({
        value,
        typeId: exactMember.typeId,
        ctx,
      }),
      abiTypes: exactMember.abiTypes,
      ctx,
      fnCtx,
    });
    return buildInlineUnionBoxFromLanes({
      layout,
      memberLayout: exactMember,
      unionBoxType,
      setup: captured.setup,
      lanes: captured.lanes,
      ctx,
    });
  }

  const heapMembers = layout.members
    .map((memberLayout) => {
      const memberInfo = getStructuralTypeInfo(memberLayout.typeId, ctx);
      if (!memberInfo || memberInfo.layoutKind !== "heap-object") {
        return undefined;
      }
      return { memberLayout, memberInfo };
    })
    .filter((entry): entry is { memberLayout: typeof layout.members[number]; memberInfo: StructuralTypeInfo } =>
      entry !== undefined,
    );
  if (heapMembers.length === 0) {
    return undefined;
  }

  const refTemp = allocateTempLocal(ctx.rtt.baseType, fnCtx);
  const baseRef = (): binaryen.ExpressionRef =>
    ctx.mod.local.get(refTemp.index, ctx.rtt.baseType);
  const mismatch = ctx.mod.unreachable();
  const boxed = heapMembers.reduceRight<binaryen.ExpressionRef>(
    (fallback, { memberLayout, memberInfo }) => {
      const captured = captureHeapUnionMemberLanes({
        value: baseRef,
        memberLayout,
        memberInfo,
        ctx,
        fnCtx,
      });
      const memberBox = buildInlineUnionBoxFromLanes({
        layout,
        memberLayout,
        unionBoxType,
        setup: captured.setup,
        lanes: captured.lanes,
        ctx,
      });
      const matches = ctx.mod.call(
        "__has_type",
        [
          ctx.mod.i32.const(memberInfo.runtimeTypeId),
          makeHeapAncestorsExpr({ pointer: baseRef, ctx }),
        ],
        binaryen.i32,
      );
      return ctx.mod.if(matches, memberBox, fallback);
    },
    mismatch,
  );

  return ctx.mod.block(
    null,
    [
      ctx.mod.local.set(
        refTemp.index,
        coerceExprToWasmType({
          expr: value,
          targetType: ctx.rtt.baseType,
          ctx,
        }),
      ),
      boxed,
    ],
    unionBoxType,
  );
};

const boxInlineValue = ({
  value,
  typeId,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  typeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "recursive") {
    const unfolded = ctx.program.types.substitute(
      desc.body,
      new Map([[desc.binder, typeId]]),
    );
    return boxInlineValue({ value, typeId: unfolded, ctx, fnCtx });
  }

  const unionBoxType = getInlineHeapBoxType({ typeId, ctx });
  if (desc.kind === "union" && unionBoxType) {
    const valueType = binaryen.getExpressionType(value);
    if (valueType === unionBoxType || valueType === binaryen.unreachable) {
      return value;
    }
    const layout = getInlineUnionLayout(typeId, ctx);
    const repackedRef = boxRefLikeUnionValue({
      value,
      unionBoxType,
      layout,
      ctx,
      fnCtx,
    });
    if (repackedRef) {
      return repackedRef;
    }
    const abiTypes = layout.abiTypes;
    const captured = captureAbiValue({ value, abiTypes, ctx, fnCtx });
    const boxed = initStruct(ctx.mod, unionBoxType, [...captured.lanes]);
    if (captured.setup.length === 0) {
      return boxed;
    }
    return ctx.mod.block(null, [...captured.setup, boxed], unionBoxType);
  }

  const structInfo = getStructuralTypeInfo(typeId, ctx);
  if (!structInfo || structInfo.layoutKind !== "value-object") {
    return value;
  }
  const valueType = binaryen.getExpressionType(value);
  if (valueType === structInfo.runtimeType || valueType === binaryen.unreachable) {
    return value;
  }
  const abiTypes = structInfo.fields.flatMap((field) => field.inlineWasmTypes);
  const captured = captureAbiValue({ value, abiTypes, ctx, fnCtx });
  const boxed = initStruct(ctx.mod, structInfo.runtimeType, [...captured.lanes]);
  if (captured.setup.length === 0) {
    return boxed;
  }
  return ctx.mod.block(null, [...captured.setup, boxed], structInfo.runtimeType);
};

const unboxInlineValue = ({
  value,
  typeId,
  ctx,
}: {
  value: binaryen.ExpressionRef;
  typeId: TypeId;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "recursive") {
    const unfolded = ctx.program.types.substitute(
      desc.body,
      new Map([[desc.binder, typeId]]),
    );
    return unboxInlineValue({ value, typeId: unfolded, ctx });
  }

  const unionBoxType = getInlineHeapBoxType({ typeId, ctx });
  if (desc.kind === "union" && unionBoxType) {
    const layout = getInlineUnionLayout(typeId, ctx);
    const lanes = layout.abiTypes.map((abiType, index) =>
      structGetFieldValue({
        mod: ctx.mod,
        fieldType: abiType,
        fieldIndex: index,
        exprRef: refCast(ctx.mod, value, unionBoxType),
      }),
    );
    return makeInlineValue({ values: lanes, ctx });
  }

  const structInfo = getStructuralTypeInfo(typeId, ctx);
  if (!structInfo || structInfo.layoutKind !== "value-object") {
    return value;
  }
  const lanes = structInfo.fields.flatMap((field) =>
    field.inlineWasmTypes.map((abiType, index) =>
      structGetFieldValue({
        mod: ctx.mod,
        fieldType: abiType,
        fieldIndex: field.runtimeIndex + index,
        exprRef: refCast(ctx.mod, value, structInfo.runtimeType),
      }),
    ),
  );
  return makeInlineValue({ values: lanes, ctx });
};

export const lowerValueForHeapField = ({
  value,
  typeId,
  targetType,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  typeId: TypeId;
  targetType: binaryen.Type;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const inlineBoxType = getInlineHeapBoxType({ typeId, ctx });
  if (inlineBoxType && targetType === inlineBoxType) {
    return boxInlineValue({ value, typeId, ctx, fnCtx });
  }
  return coerceExprToWasmType({
    expr: value,
    targetType,
    ctx,
  });
};

export const liftHeapValueToInline = ({
  value,
  typeId,
  ctx,
}: {
  value: binaryen.ExpressionRef;
  typeId: TypeId;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (getInlineHeapBoxType({ typeId, ctx })) {
    return unboxInlineValue({ value, typeId, ctx });
  }
  return coerceExprToWasmType({
    expr: value,
    targetType: wasmTypeFor(typeId, ctx),
    ctx,
  });
};

export const storeValueIntoStorageRef = ({
  pointer,
  value,
  typeId,
  ctx,
  fnCtx,
}: {
  pointer: () => binaryen.ExpressionRef;
  value: binaryen.ExpressionRef;
  typeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const storageType = getInlineHeapBoxType({ typeId, ctx });
  if (!storageType) {
    throw new Error(`cannot store non-inline value ${typeId} through a storage ref`);
  }
  const inlineValue =
    binaryen.getExpressionType(value) === storageType
      ? liftHeapValueToInline({ value, typeId, ctx })
      : coerceExprToWasmType({
          expr: value,
          targetType: wasmTypeFor(typeId, ctx),
          ctx,
        });
  const abiTypes = getDirectAbiTypesForSignature(typeId, ctx);
  const captured = captureMultivalueLanes({
    value: inlineValue,
    abiTypes,
    ctx,
    fnCtx,
  });
  return ctx.mod.block(
    null,
    [
      ...captured.setup,
      ...abiTypes.map((_, index) =>
        structSetFieldValue({
          mod: ctx.mod,
          fieldIndex: index,
          ref: refCast(ctx.mod, pointer(), storageType),
          value: captured.lanes[index]!,
        }),
      ),
    ],
    binaryen.none,
  );
};

const normalizeValueToInlineAbi = ({
  value,
  typeId,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  typeId: TypeId;
  ctx: CodegenContext;
  fnCtx?: FunctionContext;
}): binaryen.ExpressionRef => {
  const valueType = binaryen.getExpressionType(value);
  const inlineType = wasmTypeFor(typeId, ctx);
  if (valueType === inlineType || valueType === binaryen.unreachable) {
    return value;
  }
  const inlineBoxType = getInlineHeapBoxType({ typeId, ctx });
  const isRefLike =
    binaryen.expandType(valueType).length === 1 && !NON_REF_TYPES.has(valueType);
  if (inlineBoxType && isRefLike) {
    if (valueType === inlineBoxType) {
      return unboxInlineValue({ value, typeId, ctx });
    }
    if (fnCtx) {
      return unboxInlineValue({
        value: boxInlineValue({ value, typeId, ctx, fnCtx }),
        typeId,
        ctx,
      });
    }
  }
  return coerceExprToWasmType({
    expr: value,
    targetType: inlineType,
    ctx,
  });
};

const typeHasTraitRequirements = (
  typeId: TypeId,
  ctx: CodegenContext,
): boolean => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  return desc.kind === "intersection" && (desc.traits?.length ?? 0) > 0;
};

const cloneTransferredValue = ({
  value,
  typeId,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  typeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "fixed-array") {
    return value;
  }

  const structInfo = getStructuralTypeInfo(typeId, ctx);
  if (!structInfo) {
    return value;
  }
  if (structInfo.layoutKind !== "value-object") {
    return value;
  }

  const temp = allocateTempLocal(
    structInfo.interfaceType,
    fnCtx,
    typeId,
    ctx,
  );
  const fieldValues = structInfo.fields.map((field) => {
    const raw = loadStructuralField({
      structInfo,
      field,
      pointer: () => loadLocalValue(temp, ctx),
      ctx,
    });
    return coerceExprToWasmType({
      expr: cloneTransferredValue({
        value: raw,
        typeId: field.typeId,
        ctx,
        fnCtx,
      }),
      targetType: field.wasmType,
      ctx,
    });
  });
  const cloned = initStructuralValue({
    structInfo,
    fieldValues,
    ctx,
  });
  const clonedType = binaryen.getExpressionType(cloned);
  const resultTemp =
    binaryen.expandType(clonedType).length > 1
      ? allocateTempLocal(
          clonedType,
          fnCtx,
          typeId,
          ctx,
        )
      : undefined;

  return ctx.mod.block(
    null,
    [
      storeLocalValue({
        binding: temp,
        value,
        ctx,
        fnCtx,
      }),
      ...(resultTemp
        ? [
            storeLocalValue({
              binding: resultTemp,
              value: cloned,
              ctx,
              fnCtx,
            }),
            loadLocalValue(resultTemp, ctx),
          ]
        : [cloned]),
    ],
    clonedType,
  );
};

const pickUnionCoercionTarget = ({
  actualType,
  targetType,
  ctx,
}: {
  actualType: TypeId;
  targetType: TypeId;
  ctx: CodegenContext;
}): TypeId | undefined => {
  const targetDesc = ctx.program.types.getTypeDesc(targetType);
  if (
    targetDesc.kind !== "union" &&
    !shouldInlineUnionLayout(targetType, ctx)
  ) {
    return undefined;
  }

  const members =
    targetDesc.kind === "union"
      ? (() => {
          const collected: TypeId[] = [];
          const collect = (typeId: TypeId, seen: Set<TypeId>): void => {
            if (seen.has(typeId)) {
              return;
            }
            seen.add(typeId);
            const desc = ctx.program.types.getTypeDesc(typeId);
            if (desc.kind === "union") {
              desc.members.forEach((member) => collect(member, seen));
              return;
            }
            collected.push(typeId);
          };
          collect(targetType, new Set<TypeId>());
          return collected;
        })()
      : getInlineUnionLayout(targetType, ctx).members.map((member) => member.typeId);

  // Prefer exact matches to avoid "surprising" coercions when a value already
  // belongs to a specific union member but could also unify with other members
  // (e.g. structural width subtyping).
  if (members.includes(actualType)) {
    return actualType;
  }

  return members.find((member) => {
    const check = ctx.program.types.unify(actualType, member, {
      location: ctx.module.hir.module.ast,
      reason: "union coercion",
      variance: "covariant",
      allowUnknown: true,
    });
    return check.ok;
  });
};

const shouldUseNominalFieldFastPath = (
  structInfo: StructuralTypeInfo,
  ctx: CodegenContext,
): boolean =>
  Boolean(ctx.optimization && typeof structInfo.nominalId === "number");

const fieldTypesMatchExactly = (
  actualType: TypeId,
  targetType: TypeId,
  ctx: CodegenContext,
): boolean => {
  if (actualType === targetType) {
    return true;
  }

  const cache = structuralMatchCache(ctx).fieldTypes;
  const key = symmetricTypePairKey(actualType, targetType);
  const cached = cache.get(key);
  if (typeof cached === "boolean") {
    return cached;
  }

  const match = ctx.program.types.unify(actualType, targetType, {
    location: ctx.module.hir.module.ast,
    reason: "structural layout equivalence",
    variance: "invariant",
    allowUnknown: true,
  }).ok;
  cache.set(key, match);
  return match;
};

const structuralLayoutsMatchExactly = (
  actual: StructuralTypeInfo,
  target: StructuralTypeInfo,
  ctx: CodegenContext,
): boolean => {
  const actualId = actual.nominalId ?? actual.structuralId;
  const targetId = target.nominalId ?? target.structuralId;
  if (typeof actualId === "number" && typeof targetId === "number") {
    const cache = structuralMatchCache(ctx).layouts;
    const key = symmetricTypePairKey(actualId, targetId);
    const cached = cache.get(key);
    if (typeof cached === "boolean") {
      return cached;
    }

    const matches =
      actual.layoutKind === target.layoutKind &&
      (actual.structuralId === target.structuralId ||
        (typeof actual.nominalId === "number" &&
          actual.nominalId === target.nominalId)) &&
      actual.fields.length === target.fields.length &&
      actual.fields.every((field, index) => {
        const targetField = target.fields[index];
        return (
          field?.name === targetField?.name &&
          typeof targetField?.typeId === "number" &&
          fieldTypesMatchExactly(field.typeId, targetField.typeId, ctx) &&
          field?.optional === targetField?.optional
        );
      });
    cache.set(key, matches);
    return matches;
  }

  return (
    actual.layoutKind === target.layoutKind &&
    (actual.structuralId === target.structuralId ||
      (typeof actual.nominalId === "number" &&
        actual.nominalId === target.nominalId)) &&
    actual.fields.length === target.fields.length &&
    actual.fields.every((field, index) => {
      const targetField = target.fields[index];
      return (
        field?.name === targetField?.name &&
        typeof targetField?.typeId === "number" &&
        fieldTypesMatchExactly(field.typeId, targetField.typeId, ctx) &&
        field?.optional === targetField?.optional
      );
    })
  );
};

const makeHeapAncestorsExpr = ({
  pointer,
  ctx,
}: {
  pointer: () => binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef =>
  structGetFieldValue({
    mod: ctx.mod,
    fieldType: ctx.rtt.extensionHelpers.i32Array,
    fieldIndex: RTT_METADATA_SLOTS.ANCESTORS,
    exprRef: pointer(),
  });

export const initStructuralValue = ({
  structInfo,
  fieldValues,
  ctx,
}: {
  structInfo: StructuralTypeInfo;
  fieldValues: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (structInfo.layoutKind === "value-object") {
    return makeInlineValue({
      values: fieldValues.flatMap((value) => {
        const abiTypes = expandAbiTypes(binaryen.getExpressionType(value));
        return abiTypes.map((_, index) =>
          extractAbiLane({ value, abiTypes, index, ctx }),
        );
      }),
      ctx,
    });
  }
  if (
    !structInfo.ancestorsGlobal ||
    !structInfo.fieldTableGlobal ||
    !structInfo.methodTableGlobal
  ) {
    throw new Error("heap-object structural type is missing RTT lookup globals");
  }
  return initStruct(ctx.mod, structInfo.runtimeType, [
    ctx.mod.global.get(
      structInfo.ancestorsGlobal,
      ctx.rtt.extensionHelpers.i32Array
    ),
    ctx.mod.global.get(
      structInfo.fieldTableGlobal,
      ctx.rtt.fieldLookupHelpers.lookupTableType
    ),
    ctx.mod.global.get(
      structInfo.methodTableGlobal,
      ctx.rtt.methodLookupHelpers.lookupTableType
    ),
    ...fieldValues,
  ]);
};

const makeDirectStructuralFieldLoad = ({
  structInfo,
  field,
  pointer,
  ctx,
}: {
  structInfo: StructuralTypeInfo;
  field: StructuralTypeInfo["fields"][number];
  pointer: () => binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (structInfo.layoutKind === "value-object") {
    const pointerValue = pointer();
    const storageBoxType = getInlineHeapBoxType({
      typeId: structInfo.typeId,
      ctx,
    });
    return emitInlineFieldValue({
      value: pointerValue,
      field,
      storageBoxType:
        typeof storageBoxType === "number" &&
        binaryen.getExpressionType(pointerValue) === storageBoxType
          ? storageBoxType
          : undefined,
      ctx,
    });
  }
  const loaded = structGetFieldValue({
    mod: ctx.mod,
    fieldType: field.heapWasmType,
    fieldIndex: field.runtimeIndex,
    exprRef: refCast(ctx.mod, pointer(), structInfo.runtimeType),
  });
  return liftHeapValueToInline({
    value: loaded,
    typeId: field.typeId,
    ctx,
  });
};

const makeDynamicStructuralFieldLoad = ({
  field,
  pointer,
  ctx,
}: {
  field: StructuralTypeInfo["fields"][number];
  pointer: () => binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const lookupTable = structGetFieldValue({
    mod: ctx.mod,
    fieldType: ctx.rtt.fieldLookupHelpers.lookupTableType,
    fieldIndex: RTT_METADATA_SLOTS.FIELD_INDEX_TABLE,
    exprRef: pointer(),
  });
  const accessor = ctx.mod.call(
    LOOKUP_FIELD_ACCESSOR,
    [ctx.mod.i32.const(field.hash), lookupTable, ctx.mod.i32.const(0)],
    binaryen.funcref,
  );
  const getter = refCast(ctx.mod, accessor, field.getterType!);
  const loaded = callRef(ctx.mod, getter, [pointer()], field.heapWasmType);
  return liftHeapValueToInline({
    value: loaded,
    typeId: field.typeId,
    ctx,
  });
};

export const requiresStructuralConversion = (
  actualType: TypeId,
  targetType: TypeId | undefined,
  ctx: CodegenContext
): boolean => {
  if (typeof targetType !== "number" || actualType === targetType) {
    return false;
  }

  if (typeHasTraitRequirements(targetType, ctx)) {
    return false;
  }

  const targetInfo = getStructuralTypeInfo(targetType, ctx);
  if (!targetInfo) {
    return false;
  }

  const actualInfo = getStructuralTypeInfo(actualType, ctx);
  if (!actualInfo) {
    return false;
  }

  const cache = structuralMatchCache(ctx).conversions;
  const key = symmetricTypePairKey(actualType, targetType);
  const cached = cache.get(key);
  if (typeof cached === "boolean") {
    return cached;
  }

  const requires = !structuralLayoutsMatchExactly(actualInfo, targetInfo, ctx);
  cache.set(key, requires);
  return requires;
};

export const coerceValueToType = ({
  value,
  actualType,
  targetType,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  actualType: TypeId;
  targetType: TypeId | undefined;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  if (typeof targetType !== "number") {
    return cloneTransferredValue({
      value,
      typeId: actualType,
      ctx,
      fnCtx,
    });
  }
  if (actualType === targetType) {
    if (shouldInlineUnionLayout(actualType, ctx)) {
      return normalizeValueToInlineAbi({
        value,
        typeId: actualType,
        ctx,
        fnCtx,
      });
    }
    return cloneTransferredValue({
      value,
      typeId: actualType,
      ctx,
      fnCtx,
    });
  }

  const targetDesc = ctx.program.types.getTypeDesc(targetType);
  const actualDesc = ctx.program.types.getTypeDesc(actualType);
  const actualSerializer = findSerializerForType(actualType, ctx);
  const targetSerializer = findSerializerForType(targetType, ctx);
  if (
    actualSerializer &&
    targetSerializer &&
    serializerKeyFor(actualSerializer) === serializerKeyFor(targetSerializer)
  ) {
    return coerceExprToWasmType({
      expr: value,
      targetType: wasmTypeFor(targetType, ctx),
      ctx,
    });
  }

  if (targetDesc.kind === "recursive") {
    const unfolded = ctx.program.types.substitute(
      targetDesc.body,
      new Map([[targetDesc.binder, targetType]]),
    );
    return coerceValueToType({
      value,
      actualType,
      targetType: unfolded,
      ctx,
      fnCtx,
    });
  }

  if (actualDesc.kind === "recursive") {
    const unfolded = ctx.program.types.substitute(
      actualDesc.body,
      new Map([[actualDesc.binder, actualType]]),
    );
    return coerceValueToType({
      value,
      actualType: unfolded,
      targetType,
      ctx,
      fnCtx,
    });
  }

  const actualOptionalInfo = getOptionalLayoutInfo(actualType, ctx);
  const targetOptionalInfo = getOptionalLayoutInfo(targetType, ctx);
  if (
    targetOptionalInfo &&
    shouldInlineUnionLayout(targetType, ctx)
  ) {
    const targetInlineType = wasmTypeFor(targetType, ctx);
    const valueType = binaryen.getExpressionType(value);
    if (valueType === targetInlineType || valueType === binaryen.unreachable) {
      return normalizeValueToInlineAbi({
        value,
        typeId: targetType,
        ctx,
        fnCtx,
      });
    }
  }
  if (
    actualOptionalInfo &&
    targetOptionalInfo &&
    shouldInlineUnionLayout(actualType, ctx) &&
    shouldInlineUnionLayout(targetType, ctx)
  ) {
    const innerCompatibility = ctx.program.types.unify(
      actualOptionalInfo.innerType,
      targetOptionalInfo.innerType,
      {
        location: ctx.module.hir.module.ast,
        reason: "inline optional coercion",
        variance: "covariant",
        allowUnknown: true,
      },
    );
    if (innerCompatibility.ok) {
      const actualInlineOptional = shouldInlineUnionLayout(actualType, ctx);
      const targetInlineOptional = shouldInlineUnionLayout(targetType, ctx);

      if (actualInlineOptional && targetInlineOptional) {
      const actualLayout = getInlineUnionLayout(actualType, ctx);
      const targetLayout = getInlineUnionLayout(targetType, ctx);
      const actualSomeLayout = actualLayout.members.find(
        (member) => member.typeId === actualOptionalInfo.someType,
      );
      const targetSomeLayout = targetLayout.members.find(
        (member) => member.typeId === targetOptionalInfo.someType,
      );
      if (!actualSomeLayout || !targetSomeLayout) {
        throw new Error("inline optional layout is missing Some member");
      }
      const actualInlineType = wasmTypeFor(actualType, ctx);
      const actualBoxType = getInlineHeapBoxType({ typeId: actualType, ctx });
      const valueType = binaryen.getExpressionType(value);
      const directlyNormalizedActual = normalizeValueToInlineAbi({
        value,
        typeId: actualType,
        ctx,
        fnCtx,
      });
      const directlyNormalizedType = binaryen.getExpressionType(
        directlyNormalizedActual,
      );
      const normalizedActual =
        directlyNormalizedType === actualInlineType ||
        directlyNormalizedType === binaryen.unreachable
          ? directlyNormalizedActual
          : normalizeValueToInlineAbi({
              value: coerceValueToType({
                value,
                actualType: actualOptionalInfo.innerType,
                targetType: actualType,
                ctx,
                fnCtx,
              }),
              typeId: actualType,
              ctx,
              fnCtx,
            });
      const boxedActual =
        actualBoxType && valueType === actualBoxType
          ? value
          : actualBoxType
            ? boxInlineValue({
                value: normalizedActual,
                typeId: actualType,
                ctx,
                fnCtx,
              })
            : undefined;
      const canUseBoxedActual =
        actualBoxType &&
        boxedActual &&
        binaryen.getExpressionType(boxedActual) === actualBoxType;
      const boxedTemp =
        canUseBoxedActual
          ? allocateTempLocal(actualBoxType, fnCtx, actualType, ctx)
          : undefined;
      const boxedPointer = (): binaryen.ExpressionRef => {
        if (!boxedTemp || !actualBoxType) {
          throw new Error("inline optional box temp is missing");
        }
        return ctx.mod.local.get(boxedTemp.index, actualBoxType);
      };
      const tagValue =
        canUseBoxedActual
          ? structGetFieldValue({
              mod: ctx.mod,
              fieldType: actualLayout.abiTypes[0]!,
              fieldIndex: 0,
              exprRef: boxedPointer(),
            })
          : actualLayout.abiTypes.length === 1
            ? normalizedActual
            : ctx.mod.tuple.extract(normalizedActual, 0);
      const payload =
        canUseBoxedActual
          ? makeInlineValue({
              values: actualSomeLayout.abiTypes.map((abiType, index) =>
                structGetFieldValue({
                  mod: ctx.mod,
                  fieldType: abiType,
                  fieldIndex: actualSomeLayout.abiStart + index,
                  exprRef: boxedPointer(),
                }),
              ),
              ctx,
            })
          : makeInlineValue({
              values: actualSomeLayout.abiTypes.map((_, index) =>
                extractAbiLane({
                  value: normalizedActual,
                  abiTypes: actualLayout.abiTypes,
                  index: actualSomeLayout.abiStart + index,
                  ctx,
                }),
              ),
              ctx,
            });
      const inner = normalizeValueToInlineAbi({
        value: coerceValueToType({
          value: payload,
          actualType: actualOptionalInfo.innerType,
          targetType: targetOptionalInfo.innerType,
          ctx,
          fnCtx,
        }),
        typeId: targetOptionalInfo.innerType,
        ctx,
        fnCtx,
      });
      const innerAbiTypes = expandAbiTypes(binaryen.getExpressionType(inner));
      const someValue = makeInlineValue({
        values: targetLayout.abiTypes.map((abiType, index) => {
          if (index === 0) {
            return ctx.mod.i32.const(targetSomeLayout.tag);
          }
          const memberIndex = index - targetSomeLayout.abiStart;
          if (
            memberIndex >= 0 &&
            memberIndex < innerAbiTypes.length &&
            targetSomeLayout.abiStart + memberIndex === index
          ) {
            return extractAbiLane({
              value: inner,
              abiTypes: innerAbiTypes,
              index: memberIndex,
              ctx,
            });
          }
          return defaultValueForWasmType(abiType, ctx);
        }),
        ctx,
      });
      const noneValue = makeInlineValue({
        values: targetLayout.abiTypes.map((abiType, index) =>
          index === 0
            ? ctx.mod.i32.const(0)
            : defaultValueForWasmType(abiType, ctx),
        ),
        ctx,
      });
      const coerced = ctx.mod.if(
        ctx.mod.i32.eq(tagValue, ctx.mod.i32.const(0)),
        noneValue,
        someValue,
      );
      if (!boxedTemp || !canUseBoxedActual) {
        return coerced;
      }
      return ctx.mod.block(
        null,
        [
          storeLocalValue({
            binding: boxedTemp,
            value: boxedActual,
            ctx,
            fnCtx,
          }),
          coerced,
        ],
        wasmTypeFor(targetType, ctx),
      );
      }

      if (!actualInlineOptional && !targetInlineOptional) {
        const actualSomeInfo = getStructuralTypeInfo(actualOptionalInfo.someType, ctx);
        const actualNoneInfo = getStructuralTypeInfo(actualOptionalInfo.noneType, ctx);
        const targetSomeInfo = getStructuralTypeInfo(targetOptionalInfo.someType, ctx);
        const targetNoneInfo = getStructuralTypeInfo(targetOptionalInfo.noneType, ctx);
        if (
          !actualSomeInfo ||
          !actualNoneInfo ||
          !targetSomeInfo ||
          !targetNoneInfo
        ) {
          throw new Error("heap optional coercion requires structural member info");
        }
        if (
          actualSomeInfo.fields.length !== 1 ||
          targetSomeInfo.fields.length !== 1 ||
          actualNoneInfo.fields.length !== 0 ||
          targetNoneInfo.fields.length !== 0
        ) {
          throw new Error("heap optional coercion requires canonical Some/None members");
        }

        const sourceType = wasmTypeFor(actualType, ctx);
        const sourceTemp = allocateTempLocal(sourceType, fnCtx, actualType, ctx);
        const sourceRef = () =>
          coerceExprToWasmType({
            expr: loadLocalValue(sourceTemp, ctx),
            targetType: ctx.rtt.baseType,
            ctx,
          });
        const someMatches = ctx.mod.call(
          "__has_type",
          [
            ctx.mod.i32.const(actualSomeInfo.runtimeTypeId),
            makeHeapAncestorsExpr({ pointer: sourceRef, ctx }),
          ],
          binaryen.i32,
        );

        const actualSomeField = actualSomeInfo.fields[0]!;
        const targetSomeField = targetSomeInfo.fields[0]!;
        const sourceSome = () =>
          coerceExprToWasmType({
            expr: loadLocalValue(sourceTemp, ctx),
            targetType: actualSomeInfo.interfaceType,
            ctx,
          });
        const payload = coerceValueToType({
          value: loadStructuralField({
            structInfo: actualSomeInfo,
            field: actualSomeField,
            pointer: sourceSome,
            ctx,
          }),
          actualType: actualSomeField.typeId,
          targetType: targetOptionalInfo.innerType,
          ctx,
          fnCtx,
        });
        const someValue = initStructuralValue({
          structInfo: targetSomeInfo,
          fieldValues: [
            lowerValueForHeapField({
              value: payload,
              typeId: targetSomeField.typeId,
              targetType: targetSomeField.heapWasmType,
              ctx,
              fnCtx,
            }),
          ],
          ctx,
        });
        const noneValue = initStructuralValue({
          structInfo: targetNoneInfo,
          fieldValues: [],
          ctx,
        });

        return ctx.mod.block(
          null,
          [
            storeLocalValue({
              binding: sourceTemp,
              value,
              ctx,
              fnCtx,
            }),
            ctx.mod.if(someMatches, someValue, noneValue),
          ],
          wasmTypeFor(targetType, ctx),
        );
      }
    }
  }

  if (shouldInlineUnionLayout(actualType, ctx)) {
    const layout = getInlineUnionLayout(actualType, ctx);
    const valueAbiTypes = expandAbiTypes(binaryen.getExpressionType(value));
    const memberLayout = layout.members.find((member) => {
      const check = ctx.program.types.unify(member.typeId, targetType, {
        location: ctx.module.hir.module.ast,
        reason: "inline union extraction",
        variance: "covariant",
        allowUnknown: true,
      });
      return check.ok;
    });
    if (memberLayout) {
      const unionAbiTypes = layout.abiTypes;
      const sourceAbiTypes =
        valueAbiTypes.length === unionAbiTypes.length ? unionAbiTypes : valueAbiTypes;
      const extracted = makeInlineValue({
        values: memberLayout.abiTypes.map((_, index) =>
          extractAbiLane({
            value,
            abiTypes: sourceAbiTypes,
            index:
              sourceAbiTypes === unionAbiTypes
                ? memberLayout.abiStart + index
                : index,
            ctx,
          }),
        ),
        ctx,
      });
      const memberInfo = getStructuralTypeInfo(memberLayout.typeId, ctx);
      const materializedMember =
        memberInfo?.layoutKind === "heap-object"
          ? memberLayout.abiTypes.length === 0
            ? initStructuralValue({
                structInfo: memberInfo,
                fieldValues: [],
                ctx,
              })
            : abiTypeFor(memberLayout.abiTypes) !==
                wasmTypeFor(memberLayout.typeId, ctx)
              ? materializeHeapUnionMemberValue({
                  value: extracted,
                  memberLayout,
                  memberInfo,
                  ctx,
                  fnCtx,
                })
              : undefined
          : undefined;
      return coerceValueToType({
        value: materializedMember ?? extracted,
        actualType: memberLayout.typeId,
        targetType,
        ctx,
        fnCtx,
      });
    }
  }

  const optionalInfo = getOptionalLayoutInfo(targetType, ctx);

  if (optionalInfo) {
    const someInfo = getStructuralTypeInfo(optionalInfo.someType, ctx);
    if (!someInfo) {
      throw new Error("Optional wrapping requires structural type info for Some member");
    }
    if (someInfo.fields.length !== 1) {
      throw new Error("Optional Some member must contain exactly one field");
    }

    const comparison = ctx.program.types.unify(actualType, optionalInfo.innerType, {
      location: ctx.module.hir.module.ast,
      reason: "optional Some coercion",
      variance: "covariant",
      allowUnknown: true,
    });
    if (comparison.ok) {
      const wrappedInnerValue =
        actualType === optionalInfo.innerType
          ? value
          : coerceValueToType({
              value,
              actualType,
              targetType: optionalInfo.innerType,
              ctx,
              fnCtx,
            });
      const inner = normalizeValueToInlineAbi({
        value: wrappedInnerValue,
        typeId: optionalInfo.innerType,
        ctx,
        fnCtx,
      });
      if (getInlineHeapBoxType({ typeId: targetType, ctx })) {
        const layout = getInlineUnionLayout(targetType, ctx);
        const someLayout = layout.members.find(
          (member) => member.typeId === optionalInfo.someType,
        );
        if (!someLayout) {
          throw new Error("inline optional layout is missing Some member");
        }
        const innerAbiTypes = expandAbiTypes(binaryen.getExpressionType(inner));
        const capturedInner = captureAbiValue({
          value: inner,
          abiTypes: innerAbiTypes,
          ctx,
          fnCtx,
        });
        const values = layout.abiTypes.map((abiType, index) => {
          if (index === 0) {
            return ctx.mod.i32.const(someLayout.tag);
          }
          const memberIndex = index - someLayout.abiStart;
          if (
            memberIndex >= 0 &&
            memberIndex < capturedInner.lanes.length &&
            someLayout.abiStart + memberIndex === index
          ) {
            return capturedInner.lanes[memberIndex]!;
          }
          return defaultValueForWasmType(abiType, ctx);
        });
        const packed = makeInlineValue({ values, ctx });
        if (capturedInner.setup.length === 0) {
          return packed;
        }
        return ctx.mod.block(
          null,
          [...capturedInner.setup, packed],
          wasmTypeFor(targetType, ctx),
        );
      }
      const someField = someInfo.fields[0]!;
      const innerValue = lowerValueForHeapField({
        value: inner,
        typeId: someField.typeId,
        targetType: someField.heapWasmType,
        ctx,
        fnCtx,
      });
      return initStructuralValue({
        structInfo: someInfo,
        fieldValues: [innerValue],
        ctx,
      });
    }
  }

  if (targetOptionalInfo) {
    const actualInfo = getStructuralTypeInfo(actualType, ctx);
    const actualSomeCompatibility = ctx.program.types.unify(
      actualType,
      targetOptionalInfo.someType,
      {
        location: ctx.module.hir.module.ast,
        reason: "optional Some member extraction",
        variance: "covariant",
        allowUnknown: true,
      },
    );
    if (
      actualInfo &&
      actualSomeCompatibility.ok &&
      actualInfo.fields.length === 1 &&
      actualInfo.fields[0]?.name === "value"
    ) {
      const actualField = actualInfo.fields[0]!;
      const actualTemp = allocateTempLocal(
        actualType === targetOptionalInfo.someType
          ? actualInfo.runtimeType
          : actualInfo.interfaceType,
        fnCtx,
        actualType,
        ctx,
      );
      const payload = ctx.mod.block(
        null,
        [
          storeLocalValue({
            binding: actualTemp,
            value,
            ctx,
            fnCtx,
          }),
          actualType === targetOptionalInfo.someType
            ? liftHeapValueToInline({
                value: structGetFieldValue({
                  mod: ctx.mod,
                  fieldType: actualField.heapWasmType,
                  fieldIndex: actualField.runtimeIndex,
                  exprRef: loadLocalValue(actualTemp, ctx),
                }),
                typeId: actualField.typeId,
                ctx,
              })
            : loadStructuralField({
                structInfo: actualInfo,
                field: actualField,
                pointer: () => loadLocalValue(actualTemp, ctx),
                ctx,
              }),
        ],
        wasmTypeFor(actualField.typeId, ctx),
      );
      const extractedInnerValue =
        actualField.typeId === targetOptionalInfo.innerType
          ? payload
          : coerceValueToType({
              value: payload,
              actualType: actualField.typeId,
              targetType: targetOptionalInfo.innerType,
              ctx,
              fnCtx,
            });
      const inner = normalizeValueToInlineAbi({
        value: extractedInnerValue,
        typeId: targetOptionalInfo.innerType,
        ctx,
        fnCtx,
      });
      if (shouldInlineUnionLayout(targetType, ctx)) {
        const layout = getInlineUnionLayout(targetType, ctx);
        const someLayout = layout.members.find(
          (member) => member.typeId === targetOptionalInfo.someType,
        );
        if (!someLayout) {
          throw new Error("inline optional layout is missing Some member");
        }
        const innerAbiTypes = expandAbiTypes(binaryen.getExpressionType(inner));
        const capturedInner = captureAbiValue({
          value: inner,
          abiTypes: innerAbiTypes,
          ctx,
          fnCtx,
        });
        const packed = makeInlineValue({
          values: layout.abiTypes.map((abiType, index) => {
            if (index === 0) {
              return ctx.mod.i32.const(someLayout.tag);
            }
            const memberIndex = index - someLayout.abiStart;
            if (
              memberIndex >= 0 &&
              memberIndex < capturedInner.lanes.length &&
              someLayout.abiStart + memberIndex === index
            ) {
              return capturedInner.lanes[memberIndex]!;
            }
            return defaultValueForWasmType(abiType, ctx);
          }),
          ctx,
        });
        if (capturedInner.setup.length === 0) {
          return packed;
        }
        return ctx.mod.block(
          null,
          [...capturedInner.setup, packed],
          wasmTypeFor(targetType, ctx),
        );
      }

      const targetSomeInfo = getStructuralTypeInfo(targetOptionalInfo.someType, ctx);
      if (!targetSomeInfo || targetSomeInfo.fields.length !== 1) {
        throw new Error("optional Some member must contain exactly one field");
      }
      const targetSomeField = targetSomeInfo.fields[0]!;
      return initStructuralValue({
        structInfo: targetSomeInfo,
        fieldValues: [
          lowerValueForHeapField({
            value: inner,
            typeId: targetSomeField.typeId,
            targetType: targetSomeField.heapWasmType,
            ctx,
            fnCtx,
          }),
        ],
        ctx,
      });
    }
  }

  if (targetDesc.kind === "union" || shouldInlineUnionLayout(targetType, ctx)) {
    const memberTarget = pickUnionCoercionTarget({
      actualType,
      targetType,
      ctx,
    });
    if (typeof memberTarget !== "number") {
      return value;
    }
    const memberValue = normalizeValueToInlineAbi({
      value: coerceValueToType({
        value,
        actualType,
        targetType: memberTarget,
        ctx,
        fnCtx,
      }),
      typeId: memberTarget,
      ctx,
      fnCtx,
    });
    const unionBoxType = getInlineHeapBoxType({ typeId: targetType, ctx });
    if (!unionBoxType) {
      return memberValue;
    }
    const layout = getInlineUnionLayout(targetType, ctx);
    const memberLayout = layout.members.find(
      (candidate) => candidate.typeId === memberTarget,
    );
    if (!memberLayout) {
      return memberValue;
    }
    if (memberLayout.abiTypes.length === 0) {
      return makeInlineValue({
        values: layout.abiTypes.map((abiType, index) =>
          index === 0
            ? ctx.mod.i32.const(memberLayout.tag)
            : defaultValueForWasmType(abiType, ctx),
        ),
        ctx,
      });
    }
    const payloadValue = memberValue;
    const memberAbiTypes = expandAbiTypes(binaryen.getExpressionType(payloadValue));
    if (memberAbiTypes.length !== memberLayout.abiTypes.length) {
      throw new Error(
        `inline union member ABI mismatch for ${targetType}/${memberTarget}: expected ${memberLayout.abiTypes.length}, got ${memberAbiTypes.length}`,
      );
    }
    const capturedMember = captureAbiValue({
      value: payloadValue,
      abiTypes: memberAbiTypes,
      ctx,
      fnCtx,
    });
    const values = layout.abiTypes.map((abiType, index) => {
      if (index === 0) {
        return ctx.mod.i32.const(memberLayout.tag);
      }
      const memberIndex = index - memberLayout.abiStart;
      if (
        memberIndex >= 0 &&
        memberIndex < capturedMember.lanes.length &&
        memberLayout.abiStart + memberIndex === index
      ) {
        return capturedMember.lanes[memberIndex]!;
      }
      return defaultValueForWasmType(abiType, ctx);
    });
    const packed = makeInlineValue({ values, ctx });
    if (capturedMember.setup.length === 0) {
      return packed;
    }
    return ctx.mod.block(
      null,
      [...capturedMember.setup, packed],
      wasmTypeFor(targetType, ctx),
    );
  }

  if (targetDesc.kind === "fixed-array" && actualDesc.kind === "fixed-array") {
    const targetElementType = targetDesc.element;
    const actualElementType = actualDesc.element;
    const compatible = ctx.program.types.unify(actualElementType, targetElementType, {
      location: ctx.module.hir.module.ast,
      reason: "fixed-array coercion",
      variance: "covariant",
      allowUnknown: true,
    });
    if (!compatible.ok) {
      return value;
    }

    const actualArrayType = wasmTypeFor(actualType, ctx);
    const targetArrayType = wasmTypeFor(targetType, ctx);
    if (actualArrayType === targetArrayType) {
      return value;
    }
    const valueType = binaryen.getExpressionType(value);
    if (valueType !== actualArrayType) {
      return coerceExprToWasmType({
        expr: value,
        targetType: targetArrayType,
        ctx,
      });
    }

    const actualElementWasmType = wasmHeapFieldTypeFor(
      actualElementType,
      ctx,
      new Set(),
      "runtime",
    );
    const targetElementWasmType = wasmHeapFieldTypeFor(
      targetElementType,
      ctx,
      new Set(),
      "runtime",
    );

    const actualTemp = allocateTempLocal(binaryen.eqref, fnCtx);
    const targetTemp = allocateTempLocal(binaryen.eqref, fnCtx);
    const lengthTemp = allocateTempLocal(binaryen.i32, fnCtx);
    const indexTemp = allocateTempLocal(binaryen.i32, fnCtx);

    const actualRef = (): binaryen.ExpressionRef =>
      refCast(
        ctx.mod,
        ctx.mod.local.get(actualTemp.index, binaryen.eqref),
        actualArrayType,
      );
    const targetRef = (): binaryen.ExpressionRef =>
      refCast(
        ctx.mod,
        ctx.mod.local.get(targetTemp.index, binaryen.eqref),
        targetArrayType,
      );
    const len = (): binaryen.ExpressionRef =>
      ctx.mod.local.get(lengthTemp.index, binaryen.i32);
    const idx = (): binaryen.ExpressionRef =>
      ctx.mod.local.get(indexTemp.index, binaryen.i32);

    const breakLabel = `coerce_fixed_array_break_${actualType}_${targetType}_${targetTemp.index}`;
    const loopLabel = `coerce_fixed_array_loop_${actualType}_${targetType}_${targetTemp.index}`;

    const init = defaultValueForWasmType(targetElementWasmType, ctx);
    const buildTarget = ctx.mod.local.set(
      targetTemp.index,
      arrayNew(
        ctx.mod,
        binaryenTypeToHeapType(targetArrayType),
        len(),
        init,
      ),
    );

    const element = arrayGet(ctx.mod, actualRef(), idx(), actualElementWasmType, false);
    const coercedElement = coerceValueToType({
      value: element,
      actualType: actualElementType,
      targetType: targetElementType,
      ctx,
      fnCtx,
    });
    const storedElement = lowerValueForHeapField({
      value: coercedElement,
      typeId: targetElementType,
      targetType: targetElementWasmType,
      ctx,
      fnCtx,
    });

    const loopBody = ctx.mod.block(null, [
      ctx.mod.if(ctx.mod.i32.ge_u(idx(), len()), ctx.mod.br(breakLabel)),
      arraySet(ctx.mod, targetRef(), idx(), storedElement),
      ctx.mod.local.set(indexTemp.index, ctx.mod.i32.add(idx(), ctx.mod.i32.const(1))),
      ctx.mod.br(loopLabel),
    ]);

    const loop = ctx.mod.block(
      breakLabel,
      [ctx.mod.loop(loopLabel, loopBody)],
      binaryen.none,
    );

    return ctx.mod.block(
      null,
      [
        ctx.mod.local.set(actualTemp.index, value),
        ctx.mod.local.set(lengthTemp.index, arrayLen(ctx.mod, actualRef())),
        buildTarget,
        ctx.mod.local.set(indexTemp.index, ctx.mod.i32.const(0)),
        loop,
        coerceExprToWasmType({
          expr: targetRef(),
          targetType: targetArrayType,
          ctx,
        }),
      ],
      targetArrayType,
    );
  }

  if (targetDesc.kind === "function" && actualDesc.kind === "function") {
    const targetEffectful =
      typeof targetDesc.effectRow === "number" &&
      !ctx.program.effects.isEmpty(targetDesc.effectRow);
    const actualEffectful =
      typeof actualDesc.effectRow === "number" &&
      !ctx.program.effects.isEmpty(actualDesc.effectRow);

    if (targetEffectful && !actualEffectful) {
      return coercePureClosureToEffectful({
        value,
        actualType,
        targetType,
        ctx,
      });
    }
  }

  if (actualDesc.kind === "union" && !shouldInlineUnionLayout(actualType, ctx)) {
    const targetWasmType = wasmTypeFor(targetType, ctx);
    const actualWasmType = wasmTypeFor(actualType, ctx);
    if (actualWasmType === targetWasmType || targetWasmType === ctx.rtt.baseType) {
      return coerceExprToWasmType({
        expr: value,
        targetType: targetWasmType,
        ctx,
      });
    }
  }

  if (typeHasTraitRequirements(targetType, ctx)) {
    return value;
  }

  const targetInfo = getStructuralTypeInfo(targetType, ctx);
  if (!targetInfo) {
    return value;
  }

  const actualInfo = getStructuralTypeInfo(actualType, ctx);
  if (!actualInfo) {
    const actualDesc = ctx.program.types.getTypeDesc(actualType);
    const targetDesc = ctx.program.types.getTypeDesc(targetType);
    throw new Error(
      `cannot coerce non-structural value to structural type (actual=${actualType}:${actualDesc.kind}, target=${targetType}:${targetDesc.kind})`,
    );
  }
  if (structuralLayoutsMatchExactly(actualInfo, targetInfo, ctx)) {
    return value;
  }

  const tryArrayLikeConversion = (): binaryen.ExpressionRef | undefined => {
    const actualCount = actualInfo.fieldMap.get("count");
    const actualStorage = actualInfo.fieldMap.get("storage");
    const targetCount = targetInfo.fieldMap.get("count");
    const targetStorage = targetInfo.fieldMap.get("storage");
    if (!actualCount || !actualStorage || !targetCount || !targetStorage) {
      return undefined;
    }
    if (actualInfo.fields.length !== 2 || targetInfo.fields.length !== 2) {
      return undefined;
    }
    if (actualCount.wasmType !== binaryen.i32 || targetCount.wasmType !== binaryen.i32) {
      return undefined;
    }

    const isFixedArray = (typeId: TypeId): boolean => {
      const desc = ctx.program.types.getTypeDesc(typeId);
      if (desc.kind === "fixed-array") {
        return true;
      }
      if (desc.kind !== "recursive") {
        return false;
      }
      const unfolded = ctx.program.types.substitute(
        desc.body,
        new Map([[desc.binder, typeId]]),
      );
      return isFixedArray(unfolded);
    };
    if (!isFixedArray(actualStorage.typeId) || !isFixedArray(targetStorage.typeId)) {
      return undefined;
    }
    const valueType = binaryen.getExpressionType(value);
    if (valueType !== actualInfo.interfaceType) {
      return coerceExprToWasmType({
        expr: value,
        targetType: targetInfo.interfaceType,
        ctx,
      });
    }

    const temp = allocateTempLocal(
      actualInfo.interfaceType,
      fnCtx,
      actualInfo.typeId,
      ctx,
    );
    const casted = refCast(
      ctx.mod,
      coerceExprToWasmType({
        expr: loadLocalValue(temp, ctx),
        targetType: actualInfo.runtimeType,
        ctx,
      }),
      actualInfo.runtimeType,
    );

    const countValue = structGetFieldValue({
      mod: ctx.mod,
      fieldType: binaryen.i32,
      fieldIndex: actualCount.runtimeIndex,
      exprRef: casted,
    });
    const storageValue = structGetFieldValue({
      mod: ctx.mod,
      fieldType: actualStorage.heapWasmType,
      fieldIndex: actualStorage.runtimeIndex,
      exprRef: casted,
    });
    const storageCoerced = coerceValueToType({
      value: storageValue,
      actualType: actualStorage.typeId,
      targetType: targetStorage.typeId,
      ctx,
      fnCtx,
    });

    const storedStorage = coerceExprToWasmType({
      expr: storageCoerced,
      targetType: targetStorage.heapWasmType,
      ctx,
    });

    const converted = initStructuralValue({
      structInfo: targetInfo,
      fieldValues: [countValue, storedStorage],
      ctx,
    });

    return ctx.mod.block(
      null,
      [
        storeLocalValue({
          binding: temp,
          value,
          ctx,
          fnCtx,
        }),
        converted,
      ],
      targetInfo.interfaceType,
    );
  };

  const arrayLike = tryArrayLikeConversion();
  if (arrayLike) {
    return arrayLike;
  }

  return emitStructuralConversion({
    value,
    actual: actualInfo,
    target: targetInfo,
    ctx,
    fnCtx,
  });
};

const coercePureClosureToEffectful = ({
  value,
  actualType,
  targetType,
  ctx,
}: {
  value: binaryen.ExpressionRef;
  actualType: TypeId;
  targetType: TypeId;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const key = `${actualType}->${targetType}`;
  const cache = ctx.effectsState.closureCoercions;
  const cached = cache.get(key);
  if (cached) {
    return initStruct(ctx.mod, cached.envType, [
      refFunc(ctx.mod, cached.fnName, cached.fnRefType),
      value,
    ]);
  }

  const actualClosure = getClosureTypeInfo(actualType, ctx);
  const targetClosure = getClosureTypeInfo(targetType, ctx);
  const wrapperIndex = cache.size;
  const fnName = `__voyd_effect_closure_wrap_${wrapperIndex}_${actualType}_${targetType}`;
  const envType = defineStructType(ctx.mod, {
    name: `__voydEffectClosureWrapEnv_${wrapperIndex}`,
    fields: [
      { name: "__fn", type: binaryen.funcref, mutable: false },
      { name: "inner", type: actualClosure.interfaceType, mutable: false },
    ],
    supertype: binaryenTypeToHeapType(targetClosure.interfaceType),
    final: true,
  });
  const fnRefType = targetClosure.fnRefType;

  const params = binaryen.createType([
    targetClosure.interfaceType,
    ...targetClosure.paramTypes,
  ] as number[]);

  const innerEnv = () =>
    refCast(ctx.mod, ctx.mod.local.get(0, targetClosure.interfaceType), envType);
  const innerClosure = () =>
    structGetFieldValue({
      mod: ctx.mod,
      fieldIndex: 1,
      fieldType: actualClosure.interfaceType,
      exprRef: innerEnv(),
    });
  const innerFnField = structGetFieldValue({
    mod: ctx.mod,
    fieldIndex: 0,
    fieldType: binaryen.funcref,
    exprRef: innerClosure(),
  });
  const innerTarget =
    actualClosure.fnRefType === binaryen.funcref
      ? innerFnField
      : refCast(ctx.mod, innerFnField, actualClosure.fnRefType);

  const userArgsStart = 2; // [self, handler, ...userArgs]
  const callArgs = [
    innerClosure(),
    ...targetClosure.paramTypes
      .slice(1)
      .map((type, index) => ctx.mod.local.get(userArgsStart + index, type)),
  ];
  const innerResult = callRef(
    ctx.mod,
    innerTarget,
    callArgs as number[],
    actualClosure.resultType
  );
  const innerValueType = wasmTypeFor(actualDescReturnTypeId(actualType, ctx), ctx);
  const wrapperLocals: binaryen.Type[] = [];
  const wrapperScratch = {
    locals: wrapperLocals,
    nextLocalIndex: binaryen.expandType(params).length,
  };
  const wrapped =
    binaryen.getExpressionType(innerResult) === innerValueType
      ? wrapValueInOutcome({
          valueExpr: innerResult,
          valueType: innerValueType,
          ctx,
          fnCtx: wrapperScratch,
        })
      : innerResult;

  ctx.mod.addFunction(
    fnName,
    params,
    targetClosure.resultType,
    wrapperLocals,
    wrapped
  );
  cache.set(key, { envType, fnName, fnRefType });

  return initStruct(ctx.mod, envType, [refFunc(ctx.mod, fnName, fnRefType), value]);
};

const actualDescReturnTypeId = (typeId: TypeId, ctx: CodegenContext): TypeId => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind !== "function") {
    throw new Error("expected function type for closure coercion");
  }
  return desc.returnType;
};

export const emitStructuralConversion = ({
  value,
  actual,
  target,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  actual: StructuralTypeInfo;
  target: StructuralTypeInfo;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  target.fields.forEach((field) => {
    if (!actual.fieldMap.has(field.name)) {
      throw new Error(
        `structural value missing field ${field.name} required for conversion`
      );
    }
  });

  const temp = allocateTempLocal(
    actual.interfaceType,
    fnCtx,
    actual.typeId,
    ctx,
  );
  const ops: binaryen.ExpressionRef[] = [
    storeLocalValue({
      binding: temp,
      value,
      ctx,
      fnCtx,
    }),
  ];
  const sourceRef = (): binaryen.ExpressionRef =>
    loadLocalValue(temp, ctx);

  const shouldDirectFixedArrayLoad = (typeId: TypeId): boolean => {
    const desc = ctx.program.types.getTypeDesc(typeId);
    if (desc.kind === "fixed-array") {
      const elementDesc = ctx.program.types.getTypeDesc(desc.element);
      // Primitive-element fixed arrays don't suffer from the signature invariance
      // issues that arise for reference-element arrays, and their accessors are
      // safe to invoke via field tables.
      return elementDesc.kind !== "primitive";
    }
    if (desc.kind !== "recursive") {
      return false;
    }
    const unfolded = ctx.program.types.substitute(
      desc.body,
      new Map([[desc.binder, typeId]]),
    );
    return shouldDirectFixedArrayLoad(unfolded);
  };

  const fieldValues = target.fields.map((field) => {
    const sourceField = actual.fieldMap.get(field.name)!;
    const raw =
      actual.runtimeType !== ctx.rtt.baseType ||
      shouldDirectFixedArrayLoad(sourceField.typeId)
      ? (() => {
          const casted = refCast(ctx.mod, sourceRef(), actual.runtimeType);
          const loaded = structGetFieldValue({
            mod: ctx.mod,
            fieldType: sourceField.heapWasmType,
            fieldIndex: sourceField.runtimeIndex,
            exprRef: casted,
          });
          return sourceField.wasmType === sourceField.heapWasmType
            ? loaded
            : ctx.mod.block(null, [loaded], sourceField.wasmType);
        })()
      : loadStructuralField({
          structInfo: actual,
          field: sourceField,
          pointer: sourceRef,
          ctx,
        });
    const coerced = coerceValueToType({
      value: raw,
      actualType: sourceField.typeId,
      targetType: field.typeId,
      ctx,
      fnCtx,
    });
    return lowerValueForHeapField({
      value: coerced,
      typeId: field.typeId,
      targetType: field.heapWasmType,
      ctx,
      fnCtx,
    });
  });

  const converted = initStructuralValue({
    structInfo: target,
    fieldValues,
    ctx,
  });
  ops.push(converted);
  return ctx.mod.block(null, ops, target.interfaceType);
};

export const loadStructuralField = ({
  structInfo,
  field,
  pointer,
  ctx,
}: {
  structInfo: StructuralTypeInfo;
  field: StructuralTypeInfo["fields"][number];
  pointer: () => binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (structInfo.layoutKind === "value-object") {
    return makeDirectStructuralFieldLoad({
      structInfo,
      field,
      pointer,
      ctx,
    });
  }
  const dynamicLoad = makeDynamicStructuralFieldLoad({
    field,
    pointer,
    ctx,
  });
  if (!shouldUseNominalFieldFastPath(structInfo, ctx)) {
    return dynamicLoad;
  }

  const exactTypeMatch = ctx.mod.call(
    "__has_type",
    [
      ctx.mod.i32.const(structInfo.runtimeTypeId),
      makeHeapAncestorsExpr({ pointer, ctx }),
    ],
    binaryen.i32,
  );
  return ctx.mod.if(
    exactTypeMatch,
    makeDirectStructuralFieldLoad({
      structInfo,
      field,
      pointer,
      ctx,
    }),
    dynamicLoad,
  );
};

export const storeStructuralField = ({
  structInfo,
  field,
  pointer,
  value,
  ctx,
  fnCtx,
}: {
  structInfo: StructuralTypeInfo;
  field: StructuralFieldInfo;
  pointer: () => binaryen.ExpressionRef;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  if (structInfo.layoutKind === "value-object") {
    throw new Error("storing directly into inline value-object fields is not supported");
  }
  if (!field.setterType) {
    throw new Error(`missing setter for structural field ${field.name}`);
  }
  const lookupTable = structGetFieldValue({
    mod: ctx.mod,
    fieldType: ctx.rtt.fieldLookupHelpers.lookupTableType,
    fieldIndex: RTT_METADATA_SLOTS.FIELD_INDEX_TABLE,
    exprRef: pointer(),
  });
  const accessor = ctx.mod.call(
    LOOKUP_FIELD_ACCESSOR,
    [ctx.mod.i32.const(field.hash), lookupTable, ctx.mod.i32.const(1)],
    binaryen.funcref,
  );
  const setter = refCast(ctx.mod, accessor, field.setterType);
  const storedValue = lowerValueForHeapField({
    value,
    typeId: field.typeId,
    targetType: field.heapWasmType,
    ctx,
    fnCtx,
  });
  return callRef(ctx.mod, setter, [pointer(), storedValue], binaryen.none);
};
