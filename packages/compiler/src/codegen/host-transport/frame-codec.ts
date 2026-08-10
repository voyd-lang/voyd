import binaryen from "binaryen";
import { emitStringLiteral } from "../expressions/primitives.js";
import { allocateTempLocal } from "../locals.js";
import { wasmTypeFor } from "../types.js";
import type { CodegenContext, FunctionContext } from "../context.js";
import type { SelectedHostTransportProvider } from "./selected-provider.js";

export const SELECTED_HOST_FRAME_VERSION = 2;

export const SELECTED_HOST_FRAME_TAG = {
  exportInvocation: 0,
  exportCompletion: 1,
  effectRequest: 2,
  effectOutcome: 3,
  callbackInvocation: 4,
  callbackCompletion: 5,
  cancellation: 6,
  cancellationAcknowledgement: 7,
  vxCommand: 8,
  vxEvent: 9,
  vxExtensionRequest: 10,
  vxExtensionOutcome: 11,
  externalInvocation: 12,
  externalCompletion: 13,
} as const;

export const makeSelectedTypedPayload = ({
  fingerprint,
  value,
  ctx,
  fnCtx,
  provider,
}: {
  fingerprint: string;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  provider: SelectedHostTransportProvider;
}): binaryen.ExpressionRef =>
  makeSelectedArray({
    elements: [makeSelectedString(fingerprint, ctx, provider), value],
    ctx,
    fnCtx,
    provider,
  });

export const makeSelectedExportCompletion = ({
  exportName,
  fingerprint,
  value,
  ctx,
  fnCtx,
  provider,
}: {
  exportName: string;
  fingerprint: string;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  provider: SelectedHostTransportProvider;
}): binaryen.ExpressionRef => {
  const typedPayload = makeSelectedTypedPayload({
    fingerprint,
    value,
    ctx,
    fnCtx,
    provider,
  });
  const outcome = makeSelectedArray({
    elements: [makeSelectedI32(0, ctx, provider), typedPayload],
    ctx,
    fnCtx,
    provider,
  });
  return makeSelectedArray({
    elements: [
      makeSelectedI32(SELECTED_HOST_FRAME_VERSION, ctx, provider),
      makeSelectedI32(SELECTED_HOST_FRAME_TAG.exportCompletion, ctx, provider),
      makeSelectedString(exportName, ctx, provider),
      outcome,
    ],
    ctx,
    fnCtx,
    provider,
  });
};

const makeSelectedArray = ({
  elements,
  ctx,
  fnCtx,
  provider,
}: {
  elements: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  provider: SelectedHostTransportProvider;
}): binaryen.ExpressionRef => {
  const arrayType = provider.arrayWithCapacity.resultType;
  const msgPackType = wasmTypeFor(provider.msgPackTypeId, ctx);
  const local = allocateTempLocal(arrayType, fnCtx);
  const ref = () => ctx.mod.local.get(local.index, arrayType);
  return ctx.mod.block(
    null,
    [
      ctx.mod.local.set(
        local.index,
        ctx.mod.call(
          provider.arrayWithCapacity.wasmName,
          [ctx.mod.i32.const(elements.length)],
          arrayType,
        ),
      ),
      ...elements.map((element) =>
        ctx.mod.local.set(
          local.index,
          ctx.mod.call(
            provider.arrayPush.wasmName,
            [ref(), element],
            arrayType,
          ),
        ),
      ),
      ctx.mod.call(provider.makeArray.wasmName, [ref()], msgPackType),
    ],
    msgPackType,
  );
};

const makeSelectedI32 = (
  value: number,
  ctx: CodegenContext,
  provider: SelectedHostTransportProvider,
): binaryen.ExpressionRef =>
  ctx.mod.call(
    provider.makeI32.wasmName,
    [ctx.mod.i32.const(value)],
    wasmTypeFor(provider.msgPackTypeId, ctx),
  );

const makeSelectedString = (
  value: string,
  ctx: CodegenContext,
  provider: SelectedHostTransportProvider,
): binaryen.ExpressionRef =>
  ctx.mod.call(
    provider.makeString.wasmName,
    [emitStringLiteral(value, ctx)],
    wasmTypeFor(provider.msgPackTypeId, ctx),
  );
