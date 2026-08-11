import binaryen from "binaryen";
import { initDefaultStruct } from "@voyd-lang/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  FunctionContext,
  FunctionMetadata,
  TypeId,
} from "../context.js";
import {
  liftHeapValueToInline,
  storeValueIntoStorageRef,
} from "../structural.js";
import { abiTypeFor, getSignatureSpillBoxType, wasmTypeFor } from "../types.js";
import { ensureLinearMemoryExport } from "../memory-exports.js";
import { ensureSelectedHostTransportProvider } from "../host-transport/selected-provider.js";
import { withDtoFingerprint, type BoundarySchema } from "../boundary/schema.js";
import {
  readDtoValueFromHostStream,
  readHostStreamValue,
} from "../boundary/dto-stream-reader.js";
import {
  hostStreamWriterResultTypeId,
  writeDtoValueToHostStream,
  writeHostStreamEvent,
} from "../boundary/dto-stream-writer.js";
import {
  allocateTempLocal,
  loadLocalValue,
  storeLocalValue,
} from "../locals.js";
import { captureMultivalueLanes } from "../multivalue.js";
import {
  boxSignatureSpillValue,
  unboxSignatureSpillValue,
} from "../signature-spill.js";
import {
  SELECTED_HOST_FRAME_TAG,
  SELECTED_HOST_FRAME_VERSION,
} from "../host-transport/frame-codec.js";
import { hostExportId } from "./export-abi.js";
import { emitStringLiteral } from "../expressions/primitives.js";

export const emitSerializedExportWrapper = ({
  ctx,
  meta,
  exportName,
  schemas,
  wrapperExportName = exportName,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
  exportName: string;
  schemas: { params: BoundarySchema[]; result: BoundarySchema };
  wrapperExportName?: string;
}): { wrapperName: string } => {
  ensureLinearMemoryExport(ctx);

  const provider = ensureSelectedHostTransportProvider(ctx);
  const readerType = wasmTypeFor(provider.readerTypeId, ctx);
  const writerType = wasmTypeFor(provider.writerTypeId, ctx);

  const wrapperName = `${meta.wasmName}__serialized_export_${sanitizeIdentifier(exportName)}`;
  const paramCount = 4;
  const params = binaryen.createType([
    binaryen.i32,
    binaryen.i32,
    binaryen.i32,
    binaryen.i32,
  ]);
  const locals: binaryen.Type[] = [readerType, writerType];
  const argsPtrLocal = 0;
  const argsLenLocal = 1;
  const outPtrLocal = 2;
  const outLenLocal = 3;
  const readerLocal = 4;
  const writerLocal = 5;
  const fnCtx: FunctionContext = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals,
    nextLocalIndex: paramCount + locals.length,
    returnTypeId: meta.resultTypeId,
    returnWasmType: binaryen.i32,
    effectful: false,
  };

  const readerRef = () => ctx.mod.local.get(readerLocal, readerType);
  const writerRef = () => ctx.mod.local.get(writerLocal, writerType);
  const createReader = lowerSerializedExportCall({
    meta: provider.createReader,
    args: [
      ctx.mod.local.get(argsPtrLocal, binaryen.i32),
      ctx.mod.local.get(argsLenLocal, binaryen.i32),
    ],
    ctx,
    fnCtx,
  });
  const read = (name: string) =>
    readHostStreamValue({
      reader: readerRef(),
      readerTypeId: provider.readerTypeId,
      name,
      ctx,
      fnCtx,
    });
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
          ctx.mod.i32.const(hostExportId(exportName)),
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

  const buildParamExpr = (index: number): binaryen.ExpressionRef => {
    const schema = schemas.params[index]!;
    const value = allocateTempLocal(
      wasmTypeFor(schema.typeId, ctx),
      fnCtx,
      schema.typeId,
      ctx,
    );
    const fingerprint = withDtoFingerprint(schema).fingerprint;
    if (!fingerprint)
      throw new Error(
        `missing DTO fingerprint for ${exportName} argument ${index}`,
      );
    return ctx.mod.block(
      null,
      [
        ctx.mod.if(
          ctx.mod.i32.ne(read("begin_array"), ctx.mod.i32.const(2)),
          ctx.mod.unreachable(),
        ),
        ctx.mod.drop(read("read_string")),
        storeLocalValue({
          binding: value,
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
        loadLocalValue(value, ctx),
      ],
      wasmTypeFor(schema.typeId, ctx),
    );
  };

  const callArgs = meta.paramTypeIds.map((_typeId, index) =>
    buildParamExpr(index),
  );
  const loweredCall = lowerSerializedExportCall({
    meta,
    args: callArgs,
    ctx,
    fnCtx,
  });
  const loweredResultType = binaryen.getExpressionType(loweredCall.value);
  const resultLocal =
    loweredResultType === binaryen.none
      ? undefined
      : allocateTempLocal(loweredResultType, fnCtx, meta.resultTypeId, ctx);
  const evaluateCall = resultLocal
    ? storeLocalValue({
        binding: resultLocal,
        value: loweredCall.value,
        ctx,
        fnCtx,
      })
    : loweredCall.value;
  const resultValue = () =>
    resultLocal ? loadLocalValue(resultLocal, ctx) : ctx.mod.nop();
  const resultFingerprint = withDtoFingerprint(schemas.result).fingerprint;
  if (!resultFingerprint) {
    throw new Error(`missing DTO fingerprint for ${exportName} result`);
  }
  const createWriter = lowerSerializedExportCall({
    meta: provider.createWriter,
    args: [
      ctx.mod.local.get(outPtrLocal, binaryen.i32),
      ctx.mod.local.get(outLenLocal, binaryen.i32),
    ],
    ctx,
    fnCtx,
  });
  const write = (name: string, args: readonly binaryen.ExpressionRef[] = []) =>
    writeHostStreamEvent({
      writer: writerRef(),
      writerTypeId: provider.writerTypeId,
      name,
      args,
      ctx,
      fnCtx,
    });
  const dtoWriteResultTypeId = hostStreamWriterResultTypeId({
    writerTypeId: provider.writerTypeId,
    ctx,
  });
  const readerCompleteCall = lowerSerializedExportCall({
    meta: provider.readerComplete,
    args: [readerRef()],
    ctx,
    fnCtx,
  });
  const finishWriterCall = lowerSerializedExportCall({
    meta: provider.finishWriter,
    args: [writerRef()],
    ctx,
    fnCtx,
  });

  ctx.mod.addFunction(
    wrapperName,
    params,
    binaryen.i32,
    locals,
    ctx.mod.block(null, [
      ...createReader.setup,
      ctx.mod.local.set(readerLocal, createReader.value),
      checkFrame,
      checkArgs,
      ...loweredCall.setup,
      evaluateCall,
      ctx.mod.drop(read("end_array")),
      ctx.mod.drop(read("end_array")),
      ...readerCompleteCall.setup,
      ctx.mod.if(
        ctx.mod.i32.eqz(readerCompleteCall.value),
        ctx.mod.unreachable(),
      ),
      ...createWriter.setup,
      ctx.mod.local.set(writerLocal, createWriter.value),
      write("begin_array", [ctx.mod.i32.const(4)]),
      write("write_i32", [ctx.mod.i32.const(SELECTED_HOST_FRAME_VERSION)]),
      write("write_i32", [
        ctx.mod.i32.const(SELECTED_HOST_FRAME_TAG.exportCompletion),
      ]),
      write("write_i32", [ctx.mod.i32.const(hostExportId(exportName))]),
      write("begin_array", [ctx.mod.i32.const(2)]),
      write("write_i32", [ctx.mod.i32.const(0)]),
      write("begin_array", [ctx.mod.i32.const(2)]),
      write("write_string", [emitStringLiteral(resultFingerprint, ctx)]),
      ctx.mod.drop(
        writeDtoValueToHostStream({
          writer: writerRef,
          writerTypeId: provider.writerTypeId,
          value: resultValue(),
          schema: schemas.result,
          resultTypeId: dtoWriteResultTypeId,
          ctx,
          fnCtx,
        }),
      ),
      write("end_array"),
      write("end_array"),
      write("end_array"),
      ...finishWriterCall.setup,
      ctx.mod.return(finishWriterCall.value),
    ]),
  );

  ctx.mod.addFunctionExport(wrapperName, wrapperExportName);
  return { wrapperName: wrapperExportName };
};

const lowerSerializedExportCall = ({
  meta,
  args,
  ctx,
  fnCtx,
}: {
  meta: FunctionMetadata;
  args: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): {
  setup: readonly binaryen.ExpressionRef[];
  value: binaryen.ExpressionRef;
} => {
  const loweredArgs = args.map((arg, index) =>
    lowerSerializedAbiArg({
      wasmName: meta.wasmName,
      abiKind: meta.paramAbiKinds[index] ?? "direct",
      abiTypes: meta.paramAbiTypes[index] ?? [binaryen.getExpressionType(arg)],
      typeId: meta.paramTypeIds[index]!,
      value: arg,
      ctx,
      fnCtx,
    }),
  );
  const argSetup = loweredArgs.flatMap((arg) => arg.setup);
  const userArgs = loweredArgs.flatMap((arg) => arg.args);

  if (meta.resultAbiKind === "out_ref") {
    if (typeof meta.outParamType !== "number") {
      throw new Error(
        `serialized export ${meta.wasmName} is missing out-ref storage`,
      );
    }
    const out = allocateTempLocal(meta.outParamType, fnCtx);
    const outRef = () => ctx.mod.local.get(out.index, out.type);
    const initializedOut = ctx.mod.local.tee(
      out.index,
      initDefaultStruct(ctx.mod, out.type),
      out.type,
    );
    const rawCall = ctx.mod.call(
      meta.wasmName,
      [initializedOut, ...userArgs] as number[],
      meta.resultType,
    );
    return {
      setup: [...argSetup, rawCall],
      value: liftHeapValueToInline({
        value: outRef(),
        typeId: meta.resultTypeId,
        ctx,
        fnCtx,
      }),
    };
  }

  const rawCall = ctx.mod.call(
    meta.wasmName,
    userArgs as number[],
    meta.resultType,
  );
  const stabilized = stabilizeSerializedAbiResult({
    value: rawCall,
    resultType: meta.resultType,
    resultAbiTypes: meta.resultAbiTypes,
    resultTypeId: meta.resultTypeId,
    ctx,
    fnCtx,
  });
  return {
    setup: argSetup,
    value: stabilized,
  };
};

export const lowerSerializedAbiArg = ({
  wasmName,
  abiKind,
  abiTypes,
  typeId,
  value,
  ctx,
  fnCtx,
}: {
  wasmName: string;
  abiKind: string;
  abiTypes: readonly binaryen.Type[];
  typeId: TypeId;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): {
  setup: readonly binaryen.ExpressionRef[];
  args: readonly binaryen.ExpressionRef[];
} => {
  if (abiKind === "readonly_ref" || abiKind === "mutable_ref") {
    if (abiTypes.length !== 1) {
      throw new Error(
        `serialized ABI call ${wasmName} expected one ref ABI lane`,
      );
    }
    const storage = allocateTempLocal(abiTypes[0]!, fnCtx);
    const storageRef = () => ctx.mod.local.get(storage.index, storage.type);
    return {
      setup: [
        ctx.mod.local.set(
          storage.index,
          initDefaultStruct(ctx.mod, storage.type),
        ),
        storeValueIntoStorageRef({
          pointer: storageRef,
          value,
          typeId,
          ctx,
          fnCtx,
        }),
      ],
      args: [storageRef()],
    };
  }

  return flattenSerializedExportArg({
    value,
    abiTypes,
    typeId,
    wasmName,
    ctx,
    fnCtx,
  });
};

const flattenSerializedExportArg = ({
  value,
  abiTypes,
  typeId,
  wasmName,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  abiTypes: readonly binaryen.Type[];
  typeId: TypeId;
  wasmName: string;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): {
  setup: readonly binaryen.ExpressionRef[];
  args: readonly binaryen.ExpressionRef[];
} => {
  if (
    abiTypes.length === 1 &&
    getSignatureSpillBoxType({ typeId, ctx }) === abiTypes[0]
  ) {
    return {
      setup: [],
      args: [
        boxSignatureSpillValue({
          value,
          typeId,
          ctx,
          fnCtx,
        }),
      ],
    };
  }
  if (abiTypes.length <= 1) {
    return {
      setup: [],
      args: abiTypes.length === 0 ? [] : [value],
    };
  }

  const valueAbiTypes = [
    ...binaryen.expandType(binaryen.getExpressionType(value)),
  ];
  if (valueAbiTypes.length !== abiTypes.length) {
    throw new Error(
      `serialized ABI flatten mismatch for ${wasmName}: expected ${abiTypes.length} lanes, got ${valueAbiTypes.length}`,
    );
  }
  const temp = allocateTempLocal(abiTypeFor(valueAbiTypes), fnCtx, typeId, ctx);
  return {
    setup: [storeLocalValue({ binding: temp, value, ctx, fnCtx })],
    args: abiTypes.map((_, lane) =>
      ctx.mod.tuple.extract(loadLocalValue(temp, ctx), lane),
    ),
  };
};

export const stabilizeSerializedAbiResult = ({
  value,
  resultType,
  resultAbiTypes,
  resultTypeId,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  resultType: binaryen.Type;
  resultAbiTypes: readonly binaryen.Type[];
  resultTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const stabilized = stabilizeMultivalueResult({
    value,
    abiTypes: resultAbiTypes,
    ctx,
    fnCtx,
  });
  return getSignatureSpillBoxType({ typeId: resultTypeId, ctx }) === resultType
    ? unboxSignatureSpillValue({
        value: stabilized,
        typeId: resultTypeId,
        ctx,
      })
    : stabilized;
};

const stabilizeMultivalueResult = ({
  value,
  abiTypes,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  abiTypes: readonly binaryen.Type[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  if (abiTypes.length <= 1) {
    return value;
  }
  const captured = captureMultivalueLanes({
    value,
    abiTypes,
    ctx,
    fnCtx,
  });
  const tuple = ctx.mod.tuple.make(captured.lanes as binaryen.ExpressionRef[]);
  return captured.setup.length === 0
    ? tuple
    : ctx.mod.block(null, [...captured.setup, tuple], abiTypeFor(abiTypes));
};

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");
