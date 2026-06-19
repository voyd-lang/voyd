import binaryen from "binaryen";
import { arrayGet } from "@voyd-lang/lib/binaryen-gc/index.js";
import type { CodegenContext, FunctionContext, FunctionMetadata } from "../../context.js";
import { findSerializerFormatForType } from "../../serializer.js";
import { coerceValueToType } from "../../structural.js";
import { wasmTypeFor } from "../../types.js";
import type { EffectRuntime } from "../runtime-abi.js";
import { ensureDispatcher } from "../dispatcher.js";
import { ensureMsgPackFunctions } from "./msgpack.js";
import { unpackMsgPackValueForType } from "./msgpack-values.js";

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
  if (meta.paramTypes.length > 1) {
    throw new Error(
      `effectful exports with parameters are not supported yet (${exportName})`
    );
  }

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
    runtime.outcomeType
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
      ],
      runtime.effectResultType
    )
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
  if (meta.paramTypes.length > 1) {
    throw new Error(
      `effectful exports with parameters are not supported yet (${exportName})`
    );
  }

  const name = `${ctx.moduleLabel}__${exportName}`;
  const entry = buildEffectfulEntryBody({
    ctx,
    runtime,
    meta,
    exportName,
    dispatch: true,
  });
  ctx.mod.addFunction(name, entry.params, runtime.outcomeType, entry.locals, entry.result);
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
  const hasUserParams = meta.paramTypeIds.length > 0;
  const paramCount = hasUserParams ? 4 : 2;
  const inputPtrLocal = 0;
  const inputLenLocal = 1;
  const outPtrLocal = hasUserParams ? 2 : 0;
  const outLenLocal = hasUserParams ? 3 : 1;

  if (!hasUserParams) {
    return {
      params: binaryen.createType([binaryen.i32, binaryen.i32]),
      locals: [],
      result: effectfulCall({ ctx, runtime, meta, args: [] }),
      outPtrLocal,
      outLenLocal,
    };
  }

  const msgpack = ensureMsgPackFunctions(ctx);
  const msgPackType = wasmTypeFor(msgpack.msgPackTypeId, ctx);
  const arrayType = msgpack.unpackArray.resultType;
  const storageType = msgpack.arrayRawStorage.resultType;

  const argsArrayLocal = paramCount;
  const storageLocal = paramCount + 1;
  const argsCountLocal = paramCount + 2;
  const locals: binaryen.Type[] = [
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

  const decode = msgpack.decodeValue;
  const decoded = ctx.mod.call(
    decode.wasmName,
    [
      ctx.mod.local.get(inputPtrLocal, binaryen.i32),
      ctx.mod.local.get(inputLenLocal, binaryen.i32),
    ],
    decode.resultType
  );
  const decodedValue = coerceValueToType({
    value: decoded,
    actualType: decode.resultTypeId,
    targetType: msgpack.msgPackTypeId,
    ctx,
    fnCtx,
  });
  const argsArray = ctx.mod.call(
    msgpack.unpackArray.wasmName,
    [decodedValue],
    arrayType
  );
  const argsCount = ctx.mod.call(
    msgpack.arrayLength.wasmName,
    [ctx.mod.local.get(argsArrayLocal, arrayType)],
    binaryen.i32
  );
  const storage = ctx.mod.call(
    msgpack.arrayRawStorage.wasmName,
    [ctx.mod.local.get(argsArrayLocal, arrayType)],
    storageType
  );
  const checkArgs = ctx.mod.if(
    ctx.mod.i32.lt_s(
      ctx.mod.local.get(argsCountLocal, binaryen.i32),
      ctx.mod.i32.const(meta.paramTypeIds.length)
    ),
    ctx.mod.unreachable(),
    ctx.mod.nop()
  );
  const userArgs = meta.paramTypeIds.map((typeId, index) => {
    const element = arrayGet(
      ctx.mod,
      ctx.mod.local.get(storageLocal, storageType),
      ctx.mod.i32.const(index),
      msgPackType,
      false
    );
    const serializerFormat =
      meta.parameters[index]?.serializer?.formatId ??
      findSerializerFormatForType(typeId, ctx);
    if (serializerFormat === "msgpack") {
      return coerceValueToType({
        value: element,
        actualType: msgpack.msgPackTypeId,
        targetType: typeId,
        ctx,
        fnCtx,
      });
    }
    return unpackMsgPackValueForType({
      ctx,
      msgpack,
      value: element,
      typeId,
      label: `${exportName} arg${index}`,
      serializerOverride: meta.parameters[index]?.serializer,
    });
  });
  const result = effectfulCall({ ctx, runtime, meta, args: userArgs });
  const dispatched = dispatch
    ? ctx.mod.call(ensureDispatcher(ctx), [result], runtime.outcomeType)
    : result;

  return {
    params: binaryen.createType([binaryen.i32, binaryen.i32, binaryen.i32, binaryen.i32]),
    locals,
    result: ctx.mod.block(null, [
      ctx.mod.local.set(argsArrayLocal, argsArray),
      ctx.mod.local.set(storageLocal, storage),
      ctx.mod.local.set(argsCountLocal, argsCount),
      checkArgs,
      dispatched,
    ], runtime.outcomeType),
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
    runtime.outcomeType
  );
