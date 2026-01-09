import binaryen from "binaryen";
import {
  callRef,
  defineStructType,
  initStruct,
  binaryenTypeToHeapType,
  refCast,
  refFunc,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import { LOOKUP_FIELD_ACCESSOR, RTT_METADATA_SLOTS } from "./rtt/index.js";
import type {
  CodegenContext,
  StructuralFieldInfo,
  FunctionContext,
  StructuralTypeInfo,
  TypeId,
} from "./context.js";
import { allocateTempLocal } from "./locals.js";
import {
  getClosureTypeInfo,
  getStructuralTypeInfo,
  wasmTypeFor,
} from "./types.js";
import { wrapValueInOutcome } from "./effects/outcome-values.js";

export const requiresStructuralConversion = (
  actualType: TypeId,
  targetType: TypeId | undefined,
  ctx: CodegenContext
): boolean => {
  if (typeof targetType !== "number" || actualType === targetType) {
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

  return actualInfo.typeId !== targetInfo.typeId;
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
  if (typeof targetType !== "number" || actualType === targetType) {
    return value;
  }

  const targetDesc = ctx.program.types.getTypeDesc(targetType);
  const actualDesc = ctx.program.types.getTypeDesc(actualType);

  const optionalInfo = ctx.program.optionals.getOptionalInfo(ctx.moduleId, targetType);

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
      const inner = coerceValueToType({
        value,
        actualType,
        targetType: optionalInfo.innerType,
        ctx,
        fnCtx,
      });
      return initStruct(ctx.mod, someInfo.runtimeType, [
        ctx.mod.global.get(
          someInfo.ancestorsGlobal,
          ctx.rtt.extensionHelpers.i32Array
        ),
        ctx.mod.global.get(
          someInfo.fieldTableGlobal,
          ctx.rtt.fieldLookupHelpers.lookupTableType
        ),
        ctx.mod.global.get(
          someInfo.methodTableGlobal,
          ctx.rtt.methodLookupHelpers.lookupTableType
        ),
        inner,
      ]);
    }
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

  const targetInfo = getStructuralTypeInfo(targetType, ctx);
  if (!targetInfo) {
    return value;
  }

  const actualInfo = getStructuralTypeInfo(actualType, ctx);
  if (!actualInfo) {
    throw new Error("cannot coerce non-structural value to structural type");
  }

  if (actualInfo.typeId === targetInfo.typeId) {
    return value;
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
  const wrapped =
    binaryen.getExpressionType(innerResult) === innerValueType
      ? wrapValueInOutcome({ valueExpr: innerResult, valueType: innerValueType, ctx })
      : innerResult;

  ctx.mod.addFunction(
    fnName,
    params,
    targetClosure.resultType,
    [],
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

  const temp = allocateTempLocal(actual.interfaceType, fnCtx);
  const ops: binaryen.ExpressionRef[] = [ctx.mod.local.set(temp.index, value)];
  const sourceRef = ctx.mod.local.get(temp.index, actual.interfaceType);

  const fieldValues = target.fields.map((field) => {
    const sourceField = actual.fieldMap.get(field.name)!;
    const lookupTable = structGetFieldValue({
      mod: ctx.mod,
      fieldType: ctx.rtt.fieldLookupHelpers.lookupTableType,
      fieldIndex: RTT_METADATA_SLOTS.FIELD_INDEX_TABLE,
      exprRef: sourceRef,
    });
    const accessor = ctx.mod.call(
      LOOKUP_FIELD_ACCESSOR,
      [ctx.mod.i32.const(sourceField.hash), lookupTable, ctx.mod.i32.const(0)],
      binaryen.funcref
    );
    const getter = refCast(ctx.mod, accessor, sourceField.getterType!);
    return callRef(ctx.mod, getter, [sourceRef], sourceField.wasmType);
  });

  const converted = initStruct(ctx.mod, target.runtimeType, [
    ctx.mod.global.get(
      target.ancestorsGlobal,
      ctx.rtt.extensionHelpers.i32Array
    ),
    ctx.mod.global.get(
      target.fieldTableGlobal,
      ctx.rtt.fieldLookupHelpers.lookupTableType
    ),
    ctx.mod.global.get(
      target.methodTableGlobal,
      ctx.rtt.methodLookupHelpers.lookupTableType
    ),
    ...fieldValues,
  ]);
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
  pointer: binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const lookupTable = structGetFieldValue({
    mod: ctx.mod,
    fieldType: ctx.rtt.fieldLookupHelpers.lookupTableType,
    fieldIndex: RTT_METADATA_SLOTS.FIELD_INDEX_TABLE,
    exprRef: pointer,
  });
  const accessor = ctx.mod.call(
    LOOKUP_FIELD_ACCESSOR,
    [ctx.mod.i32.const(field.hash), lookupTable, ctx.mod.i32.const(0)],
    binaryen.funcref
  );
  const getter = refCast(ctx.mod, accessor, field.getterType!);
  return callRef(ctx.mod, getter, [pointer], field.wasmType);
};

export const storeStructuralField = ({
  structInfo,
  field,
  pointer,
  value,
  ctx,
}: {
  structInfo: StructuralTypeInfo;
  field: StructuralFieldInfo;
  pointer: binaryen.ExpressionRef;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (!field.setterType) {
    throw new Error(`missing setter for structural field ${field.name}`);
  }
  const lookupTable = structGetFieldValue({
    mod: ctx.mod,
    fieldType: ctx.rtt.fieldLookupHelpers.lookupTableType,
    fieldIndex: RTT_METADATA_SLOTS.FIELD_INDEX_TABLE,
    exprRef: pointer,
  });
  const accessor = ctx.mod.call(
    LOOKUP_FIELD_ACCESSOR,
    [ctx.mod.i32.const(field.hash), lookupTable, ctx.mod.i32.const(1)],
    binaryen.funcref
  );
  const setter = refCast(ctx.mod, accessor, field.setterType);
  return callRef(ctx.mod, setter, [pointer, value], binaryen.none);
};
