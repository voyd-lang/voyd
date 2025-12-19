import type binaryen from "binaryen";
import type { CodegenContext, FunctionContext } from "../../context.js";
import { getFunctionRefType } from "../../types.js";

export const handlerType = (ctx: CodegenContext): binaryen.Type =>
  ctx.effectsRuntime.handlerFrameType;

export const currentHandlerValue = (
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef => {
  if (fnCtx.currentHandler) {
    return ctx.mod.local.get(fnCtx.currentHandler.index, fnCtx.currentHandler.type);
  }
  return ctx.mod.ref.null(handlerType(ctx));
};

export const functionRefType = ({
  params,
  result,
  ctx,
}: {
  params: readonly binaryen.Type[];
  result: binaryen.Type;
  ctx: CodegenContext;
}): binaryen.Type =>
  getFunctionRefType({ params, result, ctx, label: "gc_trampoline" });

