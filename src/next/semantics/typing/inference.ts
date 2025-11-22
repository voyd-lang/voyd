import type { HirFunction } from "../hir/index.js";
import { ensureTypeMatches } from "./type-system.js";
import type { FunctionSignature, TypingContext } from "./types.js";
import { typeExpression } from "./expressions.js";

export const runInferencePass = (ctx: TypingContext): void => {
  ctx.typeCheckMode = "relaxed";
  let changed: boolean;
  do {
    clearFunctionInstances(ctx);
    ctx.table.clearExprTypes();
    ctx.resolvedExprTypes.clear();
    changed = typeAllFunctions(ctx, { collectChanges: true });
  } while (changed);

  const unresolved = Array.from(ctx.functionSignatures.entries()).filter(
    ([, signature]) => !signature.hasExplicitReturn
  );
  if (unresolved.length > 0) {
    const names = unresolved.map(([symbol]) => ctx.symbolTable.getSymbol(symbol).name);
    throw new Error(
      `could not infer return type for function(s): ${names.join(", ")}`
    );
  }
};

export const runStrictTypeCheck = (ctx: TypingContext): void => {
  ctx.typeCheckMode = "strict";
  clearFunctionInstances(ctx);
  ctx.table.clearExprTypes();
  ctx.resolvedExprTypes.clear();
  typeAllFunctions(ctx, { collectChanges: false });
};

export const typeAllFunctions = (
  ctx: TypingContext,
  options: { collectChanges: boolean }
): boolean => {
  let changed = false;
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "function") continue;
    if (item.typeParameters && item.typeParameters.length > 0) {
      continue;
    }
    const updated = typeFunction(item, ctx);
    if (options.collectChanges) {
      changed = updated || changed;
    }
  }
  return options.collectChanges ? changed : false;
};

const typeFunction = (fn: HirFunction, ctx: TypingContext): boolean => {
  const signature = ctx.functionSignatures.get(fn.symbol);
  if (!signature) {
    throw new Error(`missing type signature for function symbol ${fn.symbol}`);
  }

  if (signature.typeParams && signature.typeParams.length > 0) {
    return false;
  }

  const previousReturnType = ctx.currentFunctionReturnType;
  ctx.currentFunctionReturnType = signature.returnType;
  let bodyType;
  try {
    bodyType = typeExpression(fn.body, ctx);
  } finally {
    ctx.currentFunctionReturnType = previousReturnType;
  }
  if (signature.hasExplicitReturn) {
    ensureTypeMatches(
      bodyType,
      signature.returnType,
      ctx,
      `function ${ctx.symbolTable.getSymbol(fn.symbol).name} return type`
    );
    return false;
  }

  if (bodyType === ctx.unknownType) {
    return false;
  }

  finalizeFunctionReturnType(fn, signature, bodyType, ctx);
  return true;
};

const clearFunctionInstances = (ctx: TypingContext): void => {
  ctx.functionInstances.clear();
  ctx.activeFunctionInstantiations.clear();
  ctx.callTypeArguments.clear();
  ctx.callInstanceKeys.clear();
  ctx.functionInstantiationInfo.clear();
  ctx.functionInstanceExprTypes.clear();
};

const finalizeFunctionReturnType = (
  fn: HirFunction,
  signature: FunctionSignature,
  inferred: number,
  ctx: TypingContext
): void => {
  signature.returnType = inferred;
  const functionType = ctx.arena.internFunction({
    parameters: signature.parameters.map(({ type, label }) => ({
      type,
      label,
      optional: false,
    })),
    returnType: inferred,
    effects: ctx.defaultEffectRow,
  });
  signature.typeId = functionType;
  ctx.valueTypes.set(fn.symbol, functionType);
  const scheme = ctx.arena.newScheme([], functionType);
  ctx.table.setSymbolScheme(fn.symbol, scheme);
  signature.hasExplicitReturn = true;
};
