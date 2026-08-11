import binaryen from "binaryen";
import { arrayGet } from "@voyd-lang/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  FunctionContext,
  FunctionMetadata,
} from "../../context.js";
import { coerceValueToType } from "../../structural.js";
import { wasmTypeFor } from "../../types.js";
import type { EffectRuntime } from "../runtime-abi.js";
import { ensureDispatcher } from "../dispatcher.js";
import { ensureSelectedHostTransportProvider } from "../../host-transport/selected-provider.js";
import { readProviderValueForType } from "./provider-values.js";
import { HOST_COMPLETION_KIND } from "./handle-outcome.js";
import { hostExportId } from "../../exports/export-abi.js";
import {
  SELECTED_HOST_FRAME_TAG,
  SELECTED_HOST_FRAME_VERSION,
} from "../../host-transport/frame-codec.js";

export const createEffectfulEntry = ({
  ctx,
  runtime,
  meta,
  handleOutcome,
  exportName,
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  meta: FunctionMetadata;
  handleOutcome: string;
  exportName: string;
}): string => {
  const name = `${ctx.moduleLabel}__${exportName}`;
  const entry = buildEffectfulEntryBody({
    ctx,
    runtime,
    meta,
    exportName,
    dispatch: true,
  });
  const dispatched = ctx.mod.call(
    ensureDispatcher(ctx),
    [entry.result],
    runtime.outcomeType,
  );
  ctx.mod.addFunction(
    name,
    entry.params,
    runtime.effectResultType,
    entry.locals,
    ctx.mod.call(
      handleOutcome,
      [
        dispatched,
        ctx.mod.local.get(entry.outPtrLocal, binaryen.i32),
        ctx.mod.local.get(entry.outLenLocal, binaryen.i32),
        ctx.mod.i32.const(HOST_COMPLETION_KIND.export),
        ctx.mod.i32.const(hostExportId(exportName.replace(/_effectful$/, ""))),
      ],
      runtime.effectResultType,
    ),
  );
  ctx.mod.addFunctionExport(name, exportName);
  return name;
};

export const createEffectfulEntryRaw = ({
  ctx,
  runtime,
  meta,
  exportName,
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  meta: FunctionMetadata;
  exportName: string;
}): string => {
  const name = `${ctx.moduleLabel}__${exportName}`;
  const entry = buildEffectfulEntryBody({
    ctx,
    runtime,
    meta,
    exportName,
    dispatch: true,
  });
  ctx.mod.addFunction(
    name,
    entry.params,
    runtime.outcomeType,
    entry.locals,
    entry.result,
  );
  ctx.mod.addFunctionExport(name, exportName);
  return name;
};

const buildEffectfulEntryBody = ({
  ctx,
  runtime,
  meta,
  exportName,
  dispatch,
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  meta: FunctionMetadata;
  exportName: string;
  dispatch: boolean;
}): {
  params: binaryen.Type;
  locals: binaryen.Type[];
  result: binaryen.ExpressionRef;
  outPtrLocal: number;
  outLenLocal: number;
} => {
  const paramCount = 4;
  const inputPtrLocal = 0;
  const inputLenLocal = 1;
  const outPtrLocal = 2;
  const outLenLocal = 3;

  const provider = ensureSelectedHostTransportProvider(ctx);
  const providerValueType = wasmTypeFor(provider.valueTypeId, ctx);
  const arrayType = provider.unpackArray.resultType;
  const storageType = provider.arrayRawStorage.resultType;

  const frameArrayLocal = paramCount;
  const frameStorageLocal = paramCount + 1;
  const argsArrayLocal = paramCount + 2;
  const argsStorageLocal = paramCount + 3;
  const argsCountLocal = paramCount + 4;
  const locals: binaryen.Type[] = [
    arrayType,
    storageType,
    arrayType,
    storageType,
    binaryen.i32,
  ];
  const fnCtx: FunctionContext = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals,
    nextLocalIndex: paramCount + locals.length,
    returnTypeId: meta.resultTypeId,
    returnWasmType: runtime.outcomeType,
    effectful: true,
  };

  const decode = provider.decodeValue;
  const decoded = ctx.mod.call(
    decode.wasmName,
    [
      ctx.mod.local.get(inputPtrLocal, binaryen.i32),
      ctx.mod.local.get(inputLenLocal, binaryen.i32),
    ],
    decode.resultType,
  );
  const decodedValue = coerceValueToType({
    value: decoded,
    actualType: decode.resultTypeId,
    targetType: provider.valueTypeId,
    ctx,
    fnCtx,
  });
  const frameArray = ctx.mod.call(
    provider.unpackArray.wasmName,
    [decodedValue],
    arrayType,
  );
  const frameStorage = ctx.mod.call(
    provider.arrayRawStorage.wasmName,
    [ctx.mod.local.get(frameArrayLocal, arrayType)],
    storageType,
  );
  const frameField = (index: number): binaryen.ExpressionRef =>
    arrayGet(
      ctx.mod,
      ctx.mod.local.get(frameStorageLocal, storageType),
      ctx.mod.i32.const(index),
      providerValueType,
      false,
    );
  const argsArray = ctx.mod.call(
    provider.unpackArray.wasmName,
    [frameField(3)],
    arrayType,
  );
  const argsCount = ctx.mod.call(
    provider.arrayLength.wasmName,
    [ctx.mod.local.get(argsArrayLocal, arrayType)],
    binaryen.i32,
  );
  const argsStorage = ctx.mod.call(
    provider.arrayRawStorage.wasmName,
    [ctx.mod.local.get(argsArrayLocal, arrayType)],
    storageType,
  );
  const baseExportName = exportName.replace(/_effectful(?:_raw)?$/, "");
  const checkFrame = ctx.mod.if(
    ctx.mod.i32.or(
      ctx.mod.i32.or(
        ctx.mod.i32.ne(
          ctx.mod.call(
            provider.unpackI32.wasmName,
            [frameField(0)],
            binaryen.i32,
          ),
          ctx.mod.i32.const(SELECTED_HOST_FRAME_VERSION),
        ),
        ctx.mod.i32.ne(
          ctx.mod.call(
            provider.unpackI32.wasmName,
            [frameField(1)],
            binaryen.i32,
          ),
          ctx.mod.i32.const(SELECTED_HOST_FRAME_TAG.exportInvocation),
        ),
      ),
      ctx.mod.i32.ne(
        ctx.mod.call(
          provider.unpackI32.wasmName,
          [frameField(2)],
          binaryen.i32,
        ),
        ctx.mod.i32.const(hostExportId(baseExportName)),
      ),
    ),
    ctx.mod.unreachable(),
    ctx.mod.nop(),
  );
  const checkArgs = ctx.mod.if(
    ctx.mod.i32.ne(
      ctx.mod.local.get(argsCountLocal, binaryen.i32),
      ctx.mod.i32.const(meta.paramTypeIds.length),
    ),
    ctx.mod.unreachable(),
    ctx.mod.nop(),
  );
  const userArgs = meta.paramTypeIds.map((typeId, index) => {
    const element = arrayGet(
      ctx.mod,
      ctx.mod.local.get(argsStorageLocal, storageType),
      ctx.mod.i32.const(index),
      providerValueType,
      false,
    );
    const typedPayload = ctx.mod.call(
      provider.unpackArray.wasmName,
      [element],
      arrayType,
    );
    const typedPayloadStorage = ctx.mod.call(
      provider.arrayRawStorage.wasmName,
      [typedPayload],
      storageType,
    );
    const payload = arrayGet(
      ctx.mod,
      typedPayloadStorage,
      ctx.mod.i32.const(1),
      providerValueType,
      false,
    );
    return readProviderValueForType({
      ctx,
      provider: provider,
      value: payload,
      typeId,
      fnCtx,
      label: `${exportName} arg${index}`,
    });
  });
  const result = effectfulCall({ ctx, runtime, meta, args: userArgs });
  const dispatched = dispatch
    ? ctx.mod.call(ensureDispatcher(ctx), [result], runtime.outcomeType)
    : result;

  return {
    params: binaryen.createType([
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
    ]),
    locals,
    result: ctx.mod.block(
      null,
      [
        ctx.mod.local.set(frameArrayLocal, frameArray),
        ctx.mod.local.set(frameStorageLocal, frameStorage),
        checkFrame,
        ctx.mod.local.set(argsArrayLocal, argsArray),
        ctx.mod.local.set(argsStorageLocal, argsStorage),
        ctx.mod.local.set(argsCountLocal, argsCount),
        checkArgs,
        dispatched,
      ],
      runtime.outcomeType,
    ),
    outPtrLocal,
    outLenLocal,
  };
};

const effectfulCall = ({
  ctx,
  runtime,
  meta,
  args,
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
  meta: FunctionMetadata;
  args: binaryen.ExpressionRef[];
}): binaryen.ExpressionRef =>
  ctx.mod.call(
    meta.wasmName,
    [ctx.mod.ref.null(runtime.handlerFrameType), ...args],
    runtime.outcomeType,
  );
