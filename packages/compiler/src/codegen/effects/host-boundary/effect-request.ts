import binaryen from "binaryen";
import {
  refCast,
  structGetFieldValue,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import type { CodegenContext, FunctionContext } from "../../context.js";
import {
  writeDtoValueToHostStream,
  writeHostStreamEvent,
} from "../../boundary/dto-stream-writer.js";
import { deriveBoundarySchema } from "../../boundary/schema.js";
import type { EffectRuntime } from "../runtime-abi.js";
import type { EffectOpSignature } from "./types.js";
import {
  SELECTED_HOST_FRAME_TAG,
  SELECTED_HOST_FRAME_VERSION,
} from "../../host-transport/frame-codec.js";
import type { SelectedHostTransportProvider } from "../../host-transport/selected-provider.js";
import { emitStringLiteral } from "../../expressions/primitives.js";
import { hostStreamWriterResultTypeId } from "../../boundary/dto-stream-writer.js";

export const writeEffectRequestFrame = ({
  sig,
  request,
  provider,
  writer,
  ctx,
  runtime,
  fnCtx,
}: {
  sig: EffectOpSignature;
  request: () => binaryen.ExpressionRef;
  provider: SelectedHostTransportProvider;
  writer: () => binaryen.ExpressionRef;
  ctx: CodegenContext;
  runtime: EffectRuntime;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const write = (name: string, args: readonly binaryen.ExpressionRef[] = []) =>
    writeHostStreamEvent({
      writer: writer(),
      writerTypeId: provider.writerTypeId,
      name,
      args,
      ctx,
      fnCtx,
    });
  const resultTypeId = hostStreamWriterResultTypeId({
    writerTypeId: provider.writerTypeId,
    ctx,
  });
  const argsRef = runtime.requestArgs(request());
  const typedArgs = sig.argsType
    ? refCast(ctx.mod, argsRef, sig.argsType)
    : ctx.mod.ref.null(binaryen.eqref);
  const operations: binaryen.ExpressionRef[] = [
    write("begin_array", [ctx.mod.i32.const(9)]),
    write("write_i32", [ctx.mod.i32.const(SELECTED_HOST_FRAME_VERSION)]),
    write("write_i32", [
      ctx.mod.i32.const(SELECTED_HOST_FRAME_TAG.effectRequest),
    ]),
    write("write_i32", [ctx.mod.i32.const(sig.opIndex)]),
    write("write_string", [emitStringLiteral(sig.effectIdentity, ctx)]),
    write("write_i32", [ctx.mod.i32.const(sig.opId)]),
    write("write_i32", [ctx.mod.i32.const(sig.signatureHash)]),
    write("write_i32", [ctx.mod.i32.const(sig.resumeKind)]),
    write("begin_array", [ctx.mod.i32.const(sig.paramTypeIds.length)]),
  ];
  sig.paramTypeIds.forEach((paramTypeId, index) => {
    const schema =
      sig.externalBoundary?.params[index] ??
      deriveBoundarySchema({
        typeId: paramTypeId,
        ctx,
        label: `${sig.label} arg${index}`,
        options: { tagStandaloneVariants: true, portableNames: true },
      });
    const argValue = structGetFieldValue({
      mod: ctx.mod,
      fieldIndex: index,
      fieldType: sig.params[index]!,
      exprRef: typedArgs,
    });
    operations.push(
      write("begin_array", [ctx.mod.i32.const(2)]),
      write("write_string", [
        emitStringLiteral(sig.paramFingerprints[index]!, ctx),
      ]),
      ctx.mod.drop(
        writeDtoValueToHostStream({
          writer,
          writerTypeId: provider.writerTypeId,
          value: argValue,
          schema,
          resultTypeId,
          ctx,
          fnCtx,
        }),
      ),
      write("end_array"),
    );
  });
  operations.push(
    write("end_array"),
    write("write_string", [emitStringLiteral(sig.resultFingerprint, ctx)]),
    write("end_array"),
  );
  return ctx.mod.block(null, operations);
};
