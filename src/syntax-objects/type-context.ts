import type { Type } from "./types.js";

export type TypeContextHooks = {
  register<T extends Type>(type: T): T;
  registerMany?(types: Iterable<Type | undefined>): Type[];
};

const contextStack: TypeContextHooks[] = [];

const getCurrentContext = (): TypeContextHooks | undefined =>
  contextStack.length ? contextStack[contextStack.length - 1] : undefined;

export const withTypeContext = <T>(
  context: TypeContextHooks | undefined,
  fn: () => T
): T => {
  if (!context) return fn();
  contextStack.push(context);
  try {
    return fn();
  } finally {
    contextStack.pop();
  }
};

export const registerTypeInstance = <T extends Type | undefined>(
  type: T
): T => {
  if (!type) return type;
  const context = getCurrentContext();
  if (!context?.register) return type;
  return context.register(type);
};

export const registerTypeList = (types: Iterable<Type | undefined>): Type[] => {
  const context = getCurrentContext();
  if (!context?.registerMany) {
    return [...types].filter((value): value is Type => value !== undefined);
  }
  return context.registerMany(types);
};

export const runWithoutTypeContext = <T>(fn: () => T): T => {
  if (!contextStack.length) return fn();
  const current = contextStack.pop()!;
  try {
    return fn();
  } finally {
    contextStack.push(current);
  }
};
