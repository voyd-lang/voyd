import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  LocalBinding,
  SymbolId,
} from "./context.js";
import { structGetFieldValue } from "@voyd/lib/binaryen-gc/index.js";
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
  const binding = allocateTempLocal(wasmType, fnCtx, typeId);
  fnCtx.bindings.set(symbol, { ...binding, kind: "local", typeId });
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
  fnCtx: FunctionContext,
  typeId?: number
): LocalBinding => {
  const binding: LocalBinding = {
    kind: "local",
    index: fnCtx.nextLocalIndex,
    type,
    typeId,
  };
  fnCtx.nextLocalIndex += 1;
  fnCtx.locals.push(type);
  return binding;
};

export const loadBindingValue = (
  binding: LocalBinding,
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  if (binding.kind === "local") {
    return ctx.mod.local.get(binding.index, binding.type);
  }
  return structGetFieldValue({
    mod: ctx.mod,
    fieldIndex: binding.fieldIndex,
    fieldType: binding.type,
    exprRef: ctx.mod.local.get(binding.envIndex, binding.envType),
  });
};
