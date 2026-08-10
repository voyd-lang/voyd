import binaryen from "binaryen";
import {
  refCast,
  structGetFieldValue,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import type { CodegenContext } from "../../context.js";
import type { FunctionContext } from "../../context.js";
import { writeDtoValueToTree } from "../../boundary/dto-tree-codec.js";
import type { EffectRuntime } from "../runtime-abi.js";
import { ensureMsgPackProviderFunctions } from "../../host-transport/providers/msgpack.js";
import { packMsgPackValueForType } from "./msgpack-values.js";
import type { EffectOpSignature } from "./types.js";
import {
  makeSelectedEffectRequest,
  makeSelectedTypedPayload,
} from "../../host-transport/frame-codec.js";
import type { SelectedHostTransportProvider } from "../../host-transport/selected-provider.js";

const buildArgsArray = ({
  sig,
  request,
  msgPackType,
  msgpack,
  arrayLocal,
  ctx,
  runtime,
  fnCtx,
}: {
  sig: EffectOpSignature;
  request: () => binaryen.ExpressionRef;
  msgPackType: binaryen.Type;
  msgpack: ReturnType<typeof ensureMsgPackProviderFunctions>;
  arrayLocal: number;
  ctx: CodegenContext;
  runtime: EffectRuntime;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const arrayType = msgpack.arrayWithCapacity.resultType;
  const argsCount = sig.paramTypeIds.length;
  const initArray = ctx.mod.call(
    msgpack.arrayWithCapacity.wasmName,
    [ctx.mod.i32.const(argsCount)],
    arrayType,
  );
  const argsRef = runtime.requestArgs(request());
  const typedArgs = sig.argsType
    ? refCast(ctx.mod, argsRef, sig.argsType)
    : ctx.mod.ref.null(binaryen.eqref);

  const ops: binaryen.ExpressionRef[] = [
    ctx.mod.local.set(arrayLocal, initArray),
  ];
  sig.paramTypeIds.forEach((paramTypeId, index) => {
    const argValue = structGetFieldValue({
      mod: ctx.mod,
      fieldIndex: index,
      fieldType: sig.params[index]!,
      exprRef: typedArgs,
    });
    const boundarySchema = sig.externalBoundary?.params[index];
    const msgpackValue = boundarySchema
      ? writeDtoValueToTree({
          value: argValue,
          schema: boundarySchema,
          ctx,
          fnCtx,
          provider: msgpack,
        })
      : packMsgPackValueForType({
          value: argValue,
          typeId: paramTypeId,
          msgPackType,
          msgpack,
          ctx,
          label: `${sig.label} arg${index}`,
          serializerOverride: sig.paramSerializerOverrides?.[index],
          onUnsupported: "trap",
        });
    ops.push(
      ctx.mod.local.set(
        arrayLocal,
        ctx.mod.call(
          msgpack.arrayPush.wasmName,
          [
            ctx.mod.local.get(arrayLocal, arrayType),
            makeSelectedTypedPayload({
              fingerprint: sig.paramFingerprints[index]!,
              value: msgpackValue,
              ctx,
              fnCtx,
              provider: msgpack as SelectedHostTransportProvider,
            }),
          ],
          arrayType,
        ),
      ),
    );
  });

  return ctx.mod.block(
    null,
    [...ops, ctx.mod.local.get(arrayLocal, arrayType)],
    arrayType,
  );
};

export const buildEffectRequestMsgPack = ({
  sig,
  request,
  msgPackType,
  msgpack,
  arrayLocal,
  ctx,
  runtime,
  fnCtx,
}: {
  sig: EffectOpSignature;
  request: () => binaryen.ExpressionRef;
  msgPackType: binaryen.Type;
  msgpack: ReturnType<typeof ensureMsgPackProviderFunctions>;
  arrayLocal: number;
  ctx: CodegenContext;
  runtime: EffectRuntime;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const argsArray = buildArgsArray({
    sig,
    request,
    msgPackType,
    msgpack,
    arrayLocal,
    ctx,
    runtime,
    fnCtx,
  });
  return makeSelectedEffectRequest({
    requestId: sig.opIndex,
    effectId: sig.effectIdentity,
    operationId: sig.opId,
    signatureHash: sig.signatureHash,
    resumeKind: sig.resumeKind,
    typedArgs: ctx.mod.call(
      msgpack.makeArray.wasmName,
      [argsArray],
      msgPackType,
    ),
    resultFingerprint: sig.resultFingerprint,
    ctx,
    fnCtx,
    provider: msgpack as SelectedHostTransportProvider,
  });
};
