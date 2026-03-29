import binaryen from "binaryen";
import type { CodegenContext, FunctionContext, TypeId } from "./context.js";
import { coerceValueToType, initStructuralValue } from "./structural.js";
import { getStructuralTypeInfo } from "./types.js";

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
