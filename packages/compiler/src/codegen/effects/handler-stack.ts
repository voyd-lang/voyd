import type binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  HandlerScope,
} from "../context.js";

export const pushHandlerScope = (
  fnCtx: FunctionContext,
  scope: HandlerScope
): void => {
  if (!fnCtx.handlerStack) {
    fnCtx.handlerStack = [];
  }
  fnCtx.handlerStack.push(scope);
};

export const popHandlerScope = (fnCtx: FunctionContext): void => {
  fnCtx.handlerStack?.pop();
};

export const handlerCleanupOps = ({
  ctx,
  fnCtx,
}: {
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef[] => {
  if (!fnCtx.currentHandler) return [];
  const scopes = fnCtx.handlerStack;
  if (!scopes || scopes.length === 0) return [];
  const ops: binaryen.ExpressionRef[] = [];
  for (let index = scopes.length - 1; index >= 0; index -= 1) {
    const scope = scopes[index]!;
    ops.push(
      ctx.mod.local.set(
        fnCtx.currentHandler.index,
        ctx.mod.local.get(scope.prevHandler.index, scope.prevHandler.type)
      )
    );
  }
  return ops;
};
