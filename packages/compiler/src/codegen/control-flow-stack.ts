import type { FunctionContext, LoopScope } from "./context.js";

export const withLoopScope = <T>(
  fnCtx: FunctionContext,
  scope: LoopScope,
  run: () => T
): T => {
  fnCtx.loopStack ??= [];
  fnCtx.loopStack.push(scope);
  try {
    return run();
  } finally {
    fnCtx.loopStack.pop();
  }
};

export const resolveLoopScope = ({
  fnCtx,
  label,
}: {
  fnCtx: FunctionContext;
  label?: string;
}): LoopScope => {
  const stack = fnCtx.loopStack;
  if (!stack || stack.length === 0) {
    throw new Error("break/continue used outside of a loop");
  }
  if (!label) return stack[stack.length - 1]!;

  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const entry = stack[index]!;
    if (entry.label === label) return entry;
  }
  throw new Error(`unknown loop label '${label}'`);
};

