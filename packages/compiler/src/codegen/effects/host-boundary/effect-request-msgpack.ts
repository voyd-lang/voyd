import binaryen from "binaryen";
import { refCast, structGetFieldValue } from "@voyd/lib/binaryen-gc/index.js";
import { emitStringLiteral } from "../../expressions/primitives.js";
import type { CodegenContext } from "../../context.js";
import type { EffectRuntime } from "../runtime-abi.js";
import { EFFECT_REQUEST_MSGPACK_KEYS } from "./constants.js";
import { ensureMsgPackFunctions } from "./msgpack.js";
import { packMsgPackValueForType } from "./msgpack-values.js";
import type { EffectOpSignature } from "./types.js";

const buildArgsArray = ({
  sig,
  request,
  msgPackType,
  msgpack,
  arrayLocal,
  ctx,
  runtime,
}: {
  sig: EffectOpSignature;
  request: binaryen.ExpressionRef;
  msgPackType: binaryen.Type;
  msgpack: ReturnType<typeof ensureMsgPackFunctions>;
  arrayLocal: number;
  ctx: CodegenContext;
  runtime: EffectRuntime;
}): binaryen.ExpressionRef => {
  const arrayType = msgpack.arrayWithCapacity.resultType;
  const argsCount = sig.paramTypeIds.length;
  const initArray = ctx.mod.call(
    msgpack.arrayWithCapacity.wasmName,
    [ctx.mod.i32.const(argsCount)],
    arrayType
  );
  const argsRef = runtime.requestArgs(request);
  const typedArgs = sig.argsType
    ? refCast(ctx.mod, argsRef, sig.argsType)
    : ctx.mod.ref.null(binaryen.eqref);

  const ops: binaryen.ExpressionRef[] = [ctx.mod.local.set(arrayLocal, initArray)];
  sig.paramTypeIds.forEach((paramTypeId, index) => {
    const argValue = structGetFieldValue({
      mod: ctx.mod,
      fieldIndex: index,
      fieldType: sig.params[index]!,
      exprRef: typedArgs,
    });
    const msgpackValue = packMsgPackValueForType({
      value: argValue,
      typeId: paramTypeId,
      msgPackType,
      msgpack,
      ctx,
      label: `${sig.label} arg${index}`,
      onUnsupported: "trap",
    });
    ops.push(
      ctx.mod.local.set(
        arrayLocal,
        ctx.mod.call(
          msgpack.arrayPush.wasmName,
          [ctx.mod.local.get(arrayLocal, arrayType), msgpackValue],
          arrayType
        )
      )
    );
  });

  return ctx.mod.block(
    null,
    [...ops, ctx.mod.local.get(arrayLocal, arrayType)],
    arrayType
  );
};

const buildEffectRequestMap = ({
  request,
  argsArray,
  msgPackType,
  msgpack,
  mapLocal,
  ctx,
  runtime,
}: {
  request: binaryen.ExpressionRef;
  argsArray: binaryen.ExpressionRef;
  msgPackType: binaryen.Type;
  msgpack: ReturnType<typeof ensureMsgPackFunctions>;
  mapLocal: number;
  ctx: CodegenContext;
  runtime: EffectRuntime;
}): binaryen.ExpressionRef => {
  const mapType = msgpack.mapNew.resultType;
  const mapInit = ctx.mod.call(msgpack.mapNew.wasmName, [], mapType);
  const effectId = runtime.requestEffectId(request);
  const opId = runtime.requestOpId(request);
  const opIndex = runtime.requestOpIndex(request);
  const resumeKind = runtime.requestResumeKind(request);
  const handle = runtime.requestHandle(request);
  const keys = {
    effectId: emitStringLiteral(EFFECT_REQUEST_MSGPACK_KEYS.effectId, ctx),
    opId: emitStringLiteral(EFFECT_REQUEST_MSGPACK_KEYS.opId, ctx),
    opIndex: emitStringLiteral(EFFECT_REQUEST_MSGPACK_KEYS.opIndex, ctx),
    resumeKind: emitStringLiteral(EFFECT_REQUEST_MSGPACK_KEYS.resumeKind, ctx),
    handle: emitStringLiteral(EFFECT_REQUEST_MSGPACK_KEYS.handle, ctx),
    args: emitStringLiteral(EFFECT_REQUEST_MSGPACK_KEYS.args, ctx),
  };

  const ops: binaryen.ExpressionRef[] = [
    ctx.mod.local.set(mapLocal, mapInit),
    ctx.mod.local.set(
      mapLocal,
      ctx.mod.call(
        msgpack.mapSet.wasmName,
        [
          ctx.mod.local.get(mapLocal, mapType),
          keys.effectId,
          ctx.mod.call(msgpack.packI64.wasmName, [effectId], msgPackType),
        ],
        mapType
      )
    ),
    ctx.mod.local.set(
      mapLocal,
      ctx.mod.call(
        msgpack.mapSet.wasmName,
        [
          ctx.mod.local.get(mapLocal, mapType),
          keys.opId,
          ctx.mod.call(msgpack.packI32.wasmName, [opId], msgPackType),
        ],
        mapType
      )
    ),
    ctx.mod.local.set(
      mapLocal,
      ctx.mod.call(
        msgpack.mapSet.wasmName,
        [
          ctx.mod.local.get(mapLocal, mapType),
          keys.opIndex,
          ctx.mod.call(msgpack.packI32.wasmName, [opIndex], msgPackType),
        ],
        mapType
      )
    ),
    ctx.mod.local.set(
      mapLocal,
      ctx.mod.call(
        msgpack.mapSet.wasmName,
        [
          ctx.mod.local.get(mapLocal, mapType),
          keys.resumeKind,
          ctx.mod.call(msgpack.packI32.wasmName, [resumeKind], msgPackType),
        ],
        mapType
      )
    ),
    ctx.mod.local.set(
      mapLocal,
      ctx.mod.call(
        msgpack.mapSet.wasmName,
        [
          ctx.mod.local.get(mapLocal, mapType),
          keys.handle,
          ctx.mod.call(msgpack.packI32.wasmName, [handle], msgPackType),
        ],
        mapType
      )
    ),
    ctx.mod.local.set(
      mapLocal,
      ctx.mod.call(
        msgpack.mapSet.wasmName,
        [
          ctx.mod.local.get(mapLocal, mapType),
          keys.args,
          ctx.mod.call(msgpack.packArray.wasmName, [argsArray], msgPackType),
        ],
        mapType
      )
    ),
  ];

  return ctx.mod.block(
    null,
    [
      ...ops,
      ctx.mod.call(
        msgpack.packMap.wasmName,
        [ctx.mod.local.get(mapLocal, mapType)],
        msgPackType
      ),
    ],
    msgPackType
  );
};

export const buildEffectRequestMsgPack = ({
  sig,
  request,
  msgPackType,
  msgpack,
  arrayLocal,
  mapLocal,
  ctx,
  runtime,
}: {
  sig: EffectOpSignature;
  request: binaryen.ExpressionRef;
  msgPackType: binaryen.Type;
  msgpack: ReturnType<typeof ensureMsgPackFunctions>;
  arrayLocal: number;
  mapLocal: number;
  ctx: CodegenContext;
  runtime: EffectRuntime;
}): binaryen.ExpressionRef => {
  const argsArray = buildArgsArray({
    sig,
    request,
    msgPackType,
    msgpack,
    arrayLocal,
    ctx,
    runtime,
  });
  return buildEffectRequestMap({
    request,
    argsArray,
    msgPackType,
    msgpack,
    mapLocal,
    ctx,
    runtime,
  });
};

