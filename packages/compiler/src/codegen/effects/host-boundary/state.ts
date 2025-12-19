import type { CodegenContext } from "../../context.js";

export const stateFor = <T>(
  ctx: CodegenContext,
  key: symbol,
  init: () => T
): T => {
  const memo = ctx.effectsState.memo;
  if (memo.has(key)) return memo.get(key) as T;
  const value = init();
  memo.set(key, value);
  return value;
};

