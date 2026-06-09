import binaryen from "binaryen";
import type { CodegenContext, FunctionContext, TypeId } from "./context.js";
import { coerceValueToType, initStructuralValue } from "./structural.js";
import { getStructuralTypeInfo } from "./types.js";
import { coerceExprToWasmType } from "./wasm-type-coercions.js";

export const compileOptionalNoneValue = ({
  targetTypeId,
  ctx,
  fnCtx,
}: {
  targetTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const optionalInfo = ctx.program.optionals.getOptionalInfo(ctx.moduleId, targetTypeId);
  if (!optionalInfo) {
    throw new Error("optional default requires an Optional type");
  }

  const noneInfo = getStructuralTypeInfo(optionalInfo.noneType, ctx);
  if (!noneInfo) {
    throw new Error("optional default requires structural type info for None");
  }
  if (noneInfo.fields.length > 0) {
    throw new Error("optional default None type must not declare fields");
  }

  const noneValue = initStructuralValue({
    structInfo: noneInfo,
    fieldValues: [],
    ctx,
  });
  return coerceValueToType({
    value: noneValue,
    actualType: optionalInfo.noneType,
    targetType: targetTypeId,
    ctx,
    fnCtx,
  });
};

export const compileOptionalSomeValue = ({
  targetTypeId,
  value,
  valueTypeId,
  ctx,
  fnCtx,
}: {
  targetTypeId: TypeId;
  value: binaryen.ExpressionRef;
  valueTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const optionalInfo = ctx.program.optionals.getOptionalInfo(ctx.moduleId, targetTypeId);
  if (!optionalInfo) {
    throw new Error("optional value requires an Optional type");
  }

  const someInfo = getStructuralTypeInfo(optionalInfo.someType, ctx);
  if (!someInfo || someInfo.fields.length !== 1) {
    throw new Error("optional Some type must declare one field");
  }
  const field = someInfo.fields[0]!;
  const coerced = coerceValueToType({
    value,
    actualType: valueTypeId,
    targetType: field.typeId,
    ctx,
    fnCtx,
  });
  const someValue = initStructuralValue({
    structInfo: someInfo,
    fieldValues: [
      coerceExprToWasmType({
        expr: coerced,
        targetType:
          someInfo.layoutKind === "value-object" ? field.wasmType : field.heapWasmType,
        ctx,
      }),
    ],
    ctx,
  });
  return coerceValueToType({
    value: someValue,
    actualType: optionalInfo.someType,
    targetType: targetTypeId,
    ctx,
    fnCtx,
  });
};
