import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  LocalBinding,
  LocalBindingLocal,
  SymbolId,
} from "./context.js";
import { refCast, structGetFieldValue } from "@voyd/lib/binaryen-gc/index.js";
import { liftHeapValueToInline, lowerValueForHeapField } from "./structural.js";
import { getInlineHeapBoxType, getSymbolTypeId, wasmTypeFor } from "./types.js";
import { coerceExprToWasmType } from "./wasm-type-coercions.js";
import { captureMultivalueLanes } from "./multivalue.js";
import {
  boxSignatureSpillValue,
  isSignatureSpillStorage,
  signatureSpillStorageType,
  unboxSignatureSpillValue,
} from "./signature-spill.js";

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
  const binding = allocateTempLocal(wasmType, fnCtx, typeId, ctx);
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
  const binding = allocateTempLocal(wasmType, fnCtx, typeId, ctx);
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
  typeId?: number,
  ctx?: CodegenContext
): LocalBindingLocal => {
  const storageType =
    typeof typeId === "number" && ctx && binaryen.expandType(type).length > 1
      ? getInlineHeapBoxType({ typeId, ctx }) ??
        signatureSpillStorageType({
          typeId,
          ctx,
        })
      : type;
  const binding: LocalBindingLocal = {
    kind: "local",
    index: fnCtx.nextLocalIndex,
    type,
    storageType,
    typeId,
  };
  fnCtx.nextLocalIndex += 1;
  fnCtx.locals.push(storageType);
  return binding;
};

export const loadLocalValue = (
  binding: LocalBindingLocal,
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  const stored = ctx.mod.local.get(binding.index, binding.storageType);
  if (
    binding.storageType === binding.type ||
    typeof binding.typeId !== "number"
  ) {
    return stored;
  }
  if (isSignatureSpillStorage({
    typeId: binding.typeId,
    storageType: binding.storageType,
    ctx,
  })) {
    return unboxSignatureSpillValue({
      value: stored,
      typeId: binding.typeId,
      ctx,
    });
  }
  return liftHeapValueToInline({
    value: stored,
    typeId: binding.typeId,
    ctx,
  });
};

export const storeLocalValue = ({
  binding,
  value,
  ctx,
  fnCtx,
}: {
  binding: LocalBindingLocal;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  if (binaryen.expandType(binding.storageType).length > 1) {
    const abiTypes = [...binaryen.expandType(binding.storageType)];
    const captured = captureMultivalueLanes({
      value: coerceExprToWasmType({
        expr: value,
        targetType: binding.storageType,
        ctx,
      }),
      abiTypes,
      ctx,
      fnCtx,
    });
    const stabilized = ctx.mod.tuple.make(captured.lanes as binaryen.ExpressionRef[]);
    return captured.setup.length === 0
      ? ctx.mod.local.set(binding.index, stabilized)
      : ctx.mod.block(
          null,
          [...captured.setup, ctx.mod.local.set(binding.index, stabilized)],
          binaryen.none,
        );
  }
  if (
    binding.storageType === binding.type ||
    typeof binding.typeId !== "number"
  ) {
    return ctx.mod.local.set(
      binding.index,
      coerceExprToWasmType({
        expr: value,
        targetType: binding.storageType,
        ctx,
      }),
    );
  }
  if (isSignatureSpillStorage({
    typeId: binding.typeId,
    storageType: binding.storageType,
    ctx,
  })) {
    return ctx.mod.local.set(
      binding.index,
      boxSignatureSpillValue({
        value,
        typeId: binding.typeId,
        ctx,
        fnCtx,
      }),
    );
  }
  const stored = lowerValueForHeapField({
    value,
    typeId: binding.typeId,
    targetType: binding.storageType,
    ctx,
    fnCtx,
  });
  return ctx.mod.local.set(binding.index, stored);
};

export const loadBindingValue = (
  binding: LocalBinding,
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  if (binding.kind === "local") {
    return loadLocalValue(binding, ctx);
  }
  const envRef = ctx.mod.local.get(binding.envIndex, binding.envSuperType);
  const typedEnv =
    binding.envType === binding.envSuperType
      ? envRef
      : refCast(ctx.mod, envRef, binding.envType);
  const stored = structGetFieldValue({
    mod: ctx.mod,
    fieldIndex: binding.fieldIndex,
    fieldType: binding.storageType,
    exprRef: typedEnv,
  });
  if (
    binding.storageType === binding.type ||
    typeof binding.typeId !== "number"
  ) {
    return stored;
  }
  if (isSignatureSpillStorage({
    typeId: binding.typeId,
    storageType: binding.storageType,
    ctx,
  })) {
    return unboxSignatureSpillValue({
      value: stored,
      typeId: binding.typeId,
      ctx,
    });
  }
  return liftHeapValueToInline({
    value: stored,
    typeId: binding.typeId,
    ctx,
  });
};
