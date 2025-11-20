import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  LocalBinding,
  SymbolId,
} from "./context.js";
import { getSymbolTypeId, wasmTypeFor } from "./types.js";

export const declareLocal = (
  symbol: SymbolId,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): LocalBinding => {
  const existing = fnCtx.bindings.get(symbol);
  if (existing) {
    return existing;
  }

  const typeId = getSymbolTypeId(symbol, ctx);
  const wasmType = wasmTypeFor(typeId, ctx);
  const binding = allocateTempLocal(wasmType, fnCtx);
  fnCtx.bindings.set(symbol, binding);
  return binding;
};

export const getRequiredBinding = (
  symbol: SymbolId,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): LocalBinding => {
  const binding = fnCtx.bindings.get(symbol);
  if (!binding) {
    throw new Error(
      `codegen missing binding for symbol ${ctx.symbolTable.getSymbol(symbol).name}`
    );
  }
  return binding;
};

export const allocateTempLocal = (
  type: binaryen.Type,
  fnCtx: FunctionContext
): LocalBinding => {
  const binding: LocalBinding = {
    index: fnCtx.nextLocalIndex,
    type,
  };
  fnCtx.nextLocalIndex += 1;
  fnCtx.locals.push(type);
  return binding;
};
