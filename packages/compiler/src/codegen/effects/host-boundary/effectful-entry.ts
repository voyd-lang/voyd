import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  FunctionMetadata,
} from "../../context.js";
import { wasmTypeFor } from "../../types.js";
import type { EffectRuntime } from "../runtime-abi.js";
import { ensureDispatcher } from "../dispatcher.js";
import { ensureSelectedHostTransportProvider } from "../../host-transport/selected-provider.js";
import { HOST_COMPLETION_KIND } from "./handle-outcome.js";
import { hostExportId } from "../../exports/export-abi.js";
import {
  SELECTED_HOST_FRAME_TAG,
  SELECTED_HOST_FRAME_VERSION,
} from "../../host-transport/frame-codec.js";
import {
  readDtoValueFromHostStream,
  readHostStreamValue,
} from "../../boundary/dto-stream-reader.js";
import {
  allocateTempLocal,
  loadLocalValue,
  storeLocalValue,
} from "../../locals.js";
import { deriveBoundarySchema } from "../../boundary/schema.js";

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
  const readerType = wasmTypeFor(provider.readerTypeId, ctx);
  const readerLocal = paramCount;
  const locals: binaryen.Type[] = [readerType];
  const fnCtx: FunctionContext = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals,
    nextLocalIndex: paramCount + locals.length,
    returnTypeId: meta.resultTypeId,
    returnWasmType: runtime.outcomeType,
    effectful: true,
  };

  const readerRef = () => ctx.mod.local.get(readerLocal, readerType);
  const createReader = ctx.mod.call(
    provider.createReader.wasmName,
    [
      ctx.mod.local.get(inputPtrLocal, binaryen.i32),
      ctx.mod.local.get(inputLenLocal, binaryen.i32),
    ],
    provider.createReader.resultType,
  );
  const read = (name: string) =>
    readHostStreamValue({
      reader: readerRef(),
      readerTypeId: provider.readerTypeId,
      name,
      ctx,
      fnCtx,
    });
  const baseExportName = exportName.replace(/_effectful(?:_raw)?$/, "");
  const checkFrame = ctx.mod.if(
    ctx.mod.i32.or(
      ctx.mod.i32.or(
        ctx.mod.i32.ne(read("begin_array"), ctx.mod.i32.const(4)),
        ctx.mod.i32.ne(
          read("read_i32"),
          ctx.mod.i32.const(SELECTED_HOST_FRAME_VERSION),
        ),
      ),
      ctx.mod.i32.or(
        ctx.mod.i32.ne(
          read("read_i32"),
          ctx.mod.i32.const(SELECTED_HOST_FRAME_TAG.exportInvocation),
        ),
        ctx.mod.i32.ne(
          read("read_i32"),
          ctx.mod.i32.const(hostExportId(baseExportName)),
        ),
      ),
    ),
    ctx.mod.unreachable(),
    ctx.mod.nop(),
  );
  const checkArgs = ctx.mod.if(
    ctx.mod.i32.ne(
      read("begin_array"),
      ctx.mod.i32.const(meta.paramTypeIds.length),
    ),
    ctx.mod.unreachable(),
    ctx.mod.nop(),
  );
  const argBindings = meta.paramTypeIds.map((typeId) =>
    allocateTempLocal(wasmTypeFor(typeId, ctx), fnCtx, typeId, ctx),
  );
  const readArgs = meta.paramTypeIds.flatMap((typeId, index) => {
    const schema = deriveBoundarySchema({
      typeId,
      ctx,
      label: `${exportName} arg${index}`,
      options: { tagStandaloneVariants: true, portableNames: true },
    });
    return [
      ctx.mod.if(
        ctx.mod.i32.ne(read("begin_array"), ctx.mod.i32.const(2)),
        ctx.mod.unreachable(),
      ),
      ctx.mod.drop(read("read_string")),
      storeLocalValue({
        binding: argBindings[index]!,
        value: readDtoValueFromHostStream({
          reader: readerRef(),
          readerTypeId: provider.readerTypeId,
          schema,
          ctx,
          fnCtx,
        }),
        ctx,
        fnCtx,
      }),
      ctx.mod.drop(read("end_array")),
    ];
  });
  const userArgs = argBindings.map((binding) => loadLocalValue(binding, ctx));
  const finishRead = [
    ctx.mod.drop(read("end_array")),
    ctx.mod.drop(read("end_array")),
    ctx.mod.if(
      ctx.mod.i32.eqz(
        ctx.mod.call(
          provider.readerComplete.wasmName,
          [readerRef()],
          provider.readerComplete.resultType,
        ),
      ),
      ctx.mod.unreachable(),
    ),
  ];
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
        ctx.mod.local.set(readerLocal, createReader),
        checkFrame,
        checkArgs,
        ...readArgs,
        ...finishRead,
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
