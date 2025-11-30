import binaryen from "binaryen";
import {
  callRef,
  initStruct,
  refCast,
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
  getStructuralTypeInfo,
} from "./types.js";

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
