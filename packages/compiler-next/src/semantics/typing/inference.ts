import type { HirFunction } from "../hir/index.js";
import { ensureTypeMatches } from "./type-system.js";
import type { FunctionSignature, TypingContext, TypingState } from "./types.js";
import { formatFunctionInstanceKey, typeExpression } from "./expressions.js";
import { mergeBranchType } from "./expressions/branching.js";

export const runInferencePass = (
  ctx: TypingContext,
  state: TypingState
): void => {
  state.mode = "relaxed";
  let changed: boolean;
  do {
    clearFunctionInstances(ctx);
    ctx.table.clearExprTypes();
    ctx.resolvedExprTypes.clear();
    changed = typeAllFunctions(ctx, state, { collectChanges: true });
  } while (changed);

  const unresolved = Array.from(ctx.functions.signatures).filter(
    ([, signature]) => !signature.hasExplicitReturn
  );
  if (unresolved.length > 0) {
    const names = unresolved.map(([symbol]) => ctx.symbolTable.getSymbol(symbol).name);
    throw new Error(
      `could not infer return type for function(s): ${names.join(", ")}`
    );
  }
};

export const runStrictTypeCheck = (
  ctx: TypingContext,
  state: TypingState
): void => {
  state.mode = "strict";
  clearFunctionInstances(ctx);
  ctx.table.clearExprTypes();
  ctx.resolvedExprTypes.clear();
  typeAllFunctions(ctx, state, { collectChanges: false });
};

export const typeAllFunctions = (
  ctx: TypingContext,
  state: TypingState,
  options: { collectChanges: boolean }
): boolean => {
  let changed = false;
  for (const item of ctx.hir.items.values()) {
    if (item.kind !== "function") continue;
    if (item.typeParameters && item.typeParameters.length > 0) {
      continue;
    }
    const updated = typeFunction(item, ctx, state);
    if (options.collectChanges) {
      changed = updated || changed;
    }
  }
  return options.collectChanges ? changed : false;
};

const typeFunction = (
  fn: HirFunction,
  ctx: TypingContext,
  state: TypingState
): boolean => {
  const signature = ctx.functions.getSignature(fn.symbol);
  if (!signature) {
    throw new Error(`missing type signature for function symbol ${fn.symbol}`);
  }

  if (signature.typeParams && signature.typeParams.length > 0) {
    return false;
  }

  const previousFunction = state.currentFunction;
  state.currentFunction = {
    returnType: signature.returnType,
    instanceKey: formatFunctionInstanceKey(fn.symbol, []),
    typeParams: undefined,
    substitution: undefined,
    memberOf: ctx.memberMetadata.get(fn.symbol)?.owner,
    functionSymbol: fn.symbol,
    observedReturnType: undefined,
  };
  let bodyType;
  let observedReturnType: number | undefined;
  try {
    bodyType = typeExpression(fn.body, ctx, state, signature.returnType);
    observedReturnType = state.currentFunction?.observedReturnType;
  } finally {
    state.currentFunction = previousFunction;
  }

  const effectiveReturnType =
    typeof observedReturnType === "number"
      ? mergeBranchType({
          acc: observedReturnType,
          next: bodyType,
          ctx,
          state,
          span: fn.span,
          context: `function ${ctx.symbolTable.getSymbol(fn.symbol).name}`,
        })
      : bodyType;

  if (signature.hasExplicitReturn) {
    ensureTypeMatches(
      effectiveReturnType,
      signature.returnType,
      ctx,
      state,
      `function ${ctx.symbolTable.getSymbol(fn.symbol).name} return type`
    );
    return false;
  }

  if (effectiveReturnType === ctx.primitives.unknown) {
    return false;
  }

  finalizeFunctionReturnType(fn, signature, effectiveReturnType, ctx);
  return true;
};

const clearFunctionInstances = (ctx: TypingContext): void => {
  ctx.functions.resetInstances();
  ctx.callResolution.typeArguments.clear();
  ctx.callResolution.instanceKeys.clear();
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
    effects: ctx.primitives.defaultEffectRow,
  });
  signature.typeId = functionType;
  ctx.valueTypes.set(fn.symbol, functionType);
  const scheme = ctx.arena.newScheme([], functionType);
  ctx.table.setSymbolScheme(fn.symbol, scheme);
  signature.hasExplicitReturn = true;
  signature.annotatedReturn ||= false;
};
