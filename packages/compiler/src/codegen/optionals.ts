import binaryen from "binaryen";
import { initStruct } from "@voyd/lib/binaryen-gc/index.js";
import type { CodegenContext, FunctionContext, TypeId } from "./context.js";
import { coerceValueToType } from "./structural.js";
import { getStructuralTypeInfo } from "./types.js";
import {
  getOptionalInfo,
  optionalResolverContextForTypingResult,
} from "../semantics/typing/optionals.js";

export const compileOptionalNoneValue = ({
  targetTypeId,
  ctx,
  fnCtx,
}: {
  targetTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const optionalInfo = getOptionalInfo(
    targetTypeId,
    optionalResolverContextForTypingResult(ctx.typing)
  );
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

  const noneValue = initStruct(ctx.mod, noneInfo.runtimeType, [
    ctx.mod.global.get(
      noneInfo.ancestorsGlobal,
      ctx.rtt.extensionHelpers.i32Array
    ),
    ctx.mod.global.get(
      noneInfo.fieldTableGlobal,
      ctx.rtt.fieldLookupHelpers.lookupTableType
    ),
    ctx.mod.global.get(
      noneInfo.methodTableGlobal,
      ctx.rtt.methodLookupHelpers.lookupTableType
    ),
  ]);
  return coerceValueToType({
    value: noneValue,
    actualType: optionalInfo.noneType,
    targetType: targetTypeId,
    ctx,
    fnCtx,
  });
};
