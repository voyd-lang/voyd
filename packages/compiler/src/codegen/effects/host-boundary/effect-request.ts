import binaryen from "binaryen";
import {
  refCast,
  structGetFieldValue,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import type { CodegenContext, FunctionContext } from "../../context.js";
import { wasmTypeFor } from "../../types.js";
import { writeDtoValueToTree } from "../../boundary/dto-tree-codec.js";
import type { EffectRuntime } from "../runtime-abi.js";
import { writeProviderValueForType } from "./provider-values.js";
import type { EffectOpSignature } from "./types.js";
import {
  makeSelectedEffectRequest,
  makeSelectedTypedPayload,
} from "../../host-transport/frame-codec.js";
import type { SelectedHostTransportProvider } from "../../host-transport/selected-provider.js";

const buildArgsArray = ({
  sig,
  request,
  provider,
  arrayLocal,
  ctx,
  runtime,
  fnCtx,
}: {
  sig: EffectOpSignature;
  request: () => binaryen.ExpressionRef;
  provider: SelectedHostTransportProvider;
  arrayLocal: number;
  ctx: CodegenContext;
  runtime: EffectRuntime;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const arrayType = provider.arrayWithCapacity.resultType;
  const argsCount = sig.paramTypeIds.length;
  const initArray = ctx.mod.call(
    provider.arrayWithCapacity.wasmName,
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
    const providerValue = boundarySchema
      ? writeDtoValueToTree({
          value: argValue,
          schema: boundarySchema,
          ctx,
          fnCtx,
          provider,
        })
      : writeProviderValueForType({
          value: argValue,
          typeId: paramTypeId,
          provider,
          ctx,
          fnCtx,
          label: `${sig.label} arg${index}`,
        });
    ops.push(
      ctx.mod.local.set(
        arrayLocal,
        ctx.mod.call(
          provider.arrayPush.wasmName,
          [
            ctx.mod.local.get(arrayLocal, arrayType),
            makeSelectedTypedPayload({
              fingerprint: sig.paramFingerprints[index]!,
              value: providerValue,
              ctx,
              fnCtx,
              provider,
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

export const buildEffectRequestFrame = ({
  sig,
  request,
  provider,
  arrayLocal,
  ctx,
  runtime,
  fnCtx,
}: {
  sig: EffectOpSignature;
  request: () => binaryen.ExpressionRef;
  provider: SelectedHostTransportProvider;
  arrayLocal: number;
  ctx: CodegenContext;
  runtime: EffectRuntime;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const argsArray = buildArgsArray({
    sig,
    request,
    provider,
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
      provider.makeArray.wasmName,
      [argsArray],
      wasmTypeFor(provider.valueTypeId, ctx),
    ),
    resultFingerprint: sig.resultFingerprint,
    ctx,
    fnCtx,
    provider,
  });
};
