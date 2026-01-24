import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  LocalBinding,
  LocalBindingLocal,
  SymbolId,
} from "./context.js";
import { refCast, structGetFieldValue } from "@voyd/lib/binaryen-gc/index.js";
import { getSymbolTypeId, wasmTypeFor } from "./types.js";

export const declareLocalWithTypeId = (
  symbol: SymbolId,
  typeId: number,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): LocalBinding => {
  const existing = fnCtx.bindings.get(symbol);
  if (existing) {
    return existing;
  }

  const wasmType = wasmTypeFor(typeId, ctx);
  const binding = allocateTempLocal(wasmType, fnCtx, typeId);
  fnCtx.bindings.set(symbol, { ...binding, kind: "local", typeId });
  return binding;
};

export const declareLocal = (
  symbol: SymbolId,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): LocalBinding => {
  const existing = fnCtx.bindings.get(symbol);
  if (existing) {
    return existing;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const typeId = getSymbolTypeId(symbol, ctx, typeInstanceId);
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
    const name =
      ctx.program.symbols.getName(
        ctx.program.symbols.idOf({ moduleId: ctx.moduleId, symbol })
      ) ?? `${symbol}`;
    throw new Error(
      `codegen missing binding for symbol ${name}`
    );
  }
  return binding;
};

export const allocateTempLocal = (
  type: binaryen.Type,
  fnCtx: FunctionContext,
  typeId?: number
): LocalBindingLocal => {
  const binding: LocalBindingLocal = {
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
  const envRef = ctx.mod.local.get(binding.envIndex, binding.envSuperType);
  const typedEnv =
    binding.envType === binding.envSuperType
      ? envRef
      : refCast(ctx.mod, envRef, binding.envType);
  return structGetFieldValue({
    mod: ctx.mod,
    fieldIndex: binding.fieldIndex,
    fieldType: binding.type,
    exprRef: typedEnv,
  });
};
