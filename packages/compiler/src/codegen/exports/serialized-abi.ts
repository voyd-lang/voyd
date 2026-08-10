import binaryen from "binaryen";
import {
  arrayGet,
  initDefaultStruct,
} from "@voyd-lang/lib/binaryen-gc/index.js";
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
import {
  deriveBoundarySchema,
  withDtoFingerprint,
} from "../boundary/schema.js";
import {
  writeDtoValueToTree,
  readDtoValueFromTree,
} from "../boundary/dto-tree-codec.js";
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
  makeSelectedExportCompletion,
  SELECTED_HOST_FRAME_TAG,
  SELECTED_HOST_FRAME_VERSION,
} from "../host-transport/frame-codec.js";
import { hostExportId } from "./export-abi.js";

export const emitSerializedExportWrapper = ({
  ctx,
  meta,
  exportName,
  wrapperExportName = exportName,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
  exportName: string;
  wrapperExportName?: string;
}): { wrapperName: string } => {
  ensureLinearMemoryExport(ctx);
  validateExportTypes({
    ctx,
    meta,
    exportName,
  });

  const provider = ensureSelectedHostTransportProvider(ctx);
  const providerValueType = wasmTypeFor(provider.valueTypeId, ctx);
  const arrayType = provider.arrayWithCapacity.resultType;
  const storageType = provider.arrayRawStorage.resultType;

  const wrapperName = `${meta.wasmName}__serialized_export_${sanitizeIdentifier(exportName)}`;
  const paramCount = 4;
  const params = binaryen.createType([
    binaryen.i32,
    binaryen.i32,
    binaryen.i32,
    binaryen.i32,
  ]);
  const locals: binaryen.Type[] = [
    providerValueType, // decodedLocal
    arrayType, // frameArrayLocal
    storageType, // frameStorageLocal
    arrayType, // argsArrayLocal
    storageType, // argsStorageLocal
    binaryen.i32, // argsCountLocal
  ];
  const argsPtrLocal = 0;
  const argsLenLocal = 1;
  const outPtrLocal = 2;
  const outLenLocal = 3;
  const decodedLocal = 4;
  const frameArrayLocal = 5;
  const frameStorageLocal = 6;
  const argsArrayLocal = 7;
  const argsStorageLocal = 8;
  const argsCountLocal = 9;
  const fnCtx: FunctionContext = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals,
    nextLocalIndex: paramCount + locals.length,
    returnTypeId: meta.resultTypeId,
    returnWasmType: binaryen.i32,
    effectful: false,
  };

  const decoded = ctx.mod.call(
    provider.decodeValue.wasmName,
    [
      ctx.mod.local.get(argsPtrLocal, binaryen.i32),
      ctx.mod.local.get(argsLenLocal, binaryen.i32),
    ],
    providerValueType,
  );

  const frameArray = ctx.mod.call(
    provider.unpackArray.wasmName,
    [ctx.mod.local.get(decodedLocal, providerValueType)],
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
        ctx.mod.call(provider.unpackI32.wasmName, [frameField(2)], binaryen.i32),
        ctx.mod.i32.const(hostExportId(exportName)),
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

  const buildParamExpr = (
    typeId: number,
    index: number,
  ): binaryen.ExpressionRef => {
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
    return readDtoValueFromTree({
      ctx,
      value: payload,
      schema: deriveBoundarySchema({
        typeId,
        ctx,
        label: `${exportName} arg${index}`,
      }),
      fnCtx,
      provider,
    });
  };

  const callArgs = meta.paramTypeIds.map((typeId, index) =>
    buildParamExpr(typeId, index),
  );
  const loweredCall = lowerSerializedExportCall({
    meta,
    args: callArgs,
    ctx,
    fnCtx,
  });
  const encodeValue = packSerializedResultValue({
    value: loweredCall.value,
    typeId: meta.resultTypeId,
    ctx,
    fnCtx,
    exportName,
  });
  const resultFingerprint = withDtoFingerprint(
    deriveBoundarySchema({
      typeId: meta.resultTypeId,
      ctx,
      label: `${exportName} result`,
    }),
  ).fingerprint;
  if (!resultFingerprint) {
    throw new Error(`missing DTO fingerprint for ${exportName} result`);
  }
  const completionFrame = makeSelectedExportCompletion({
    exportId: hostExportId(exportName),
    fingerprint: resultFingerprint,
    value: encodeValue,
    ctx,
    fnCtx,
    provider,
  });
  const encodedLength = ctx.mod.call(
    provider.encodeValue.wasmName,
    [
      completionFrame,
      ctx.mod.local.get(outPtrLocal, binaryen.i32),
      ctx.mod.local.get(outLenLocal, binaryen.i32),
    ],
    binaryen.i32,
  );

  ctx.mod.addFunction(
    wrapperName,
    params,
    binaryen.i32,
    locals,
    ctx.mod.block(null, [
      ctx.mod.local.set(decodedLocal, decoded),
      ctx.mod.local.set(frameArrayLocal, frameArray),
      ctx.mod.local.set(frameStorageLocal, frameStorage),
      checkFrame,
      ctx.mod.local.set(argsArrayLocal, argsArray),
      ctx.mod.local.set(argsStorageLocal, argsStorage),
      ctx.mod.local.set(argsCountLocal, argsCount),
      checkArgs,
      ...loweredCall.setup,
      ctx.mod.return(encodedLength),
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

const validateExportTypes = ({
  ctx,
  meta,
  exportName,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
  exportName: string;
}): void => {
  const allTypes = [...meta.paramTypeIds, meta.resultTypeId];
  allTypes.forEach((typeId, index) => {
    const target =
      index < meta.paramTypeIds.length ? `parameter ${index + 1}` : "return";
    deriveBoundarySchema({
      typeId,
      ctx,
      label: `${exportName} ${target}`,
    });
  });
};

const packSerializedResultValue = ({
  value,
  typeId,
  ctx,
  fnCtx,
  exportName,
}: {
  value: binaryen.ExpressionRef;
  typeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  exportName: string;
}): binaryen.ExpressionRef => {
  const provider = ensureSelectedHostTransportProvider(ctx);
  return writeDtoValueToTree({
    value,
    schema: deriveBoundarySchema({
      typeId,
      ctx,
      label: `${exportName} result`,
    }),
    ctx,
    fnCtx,
    provider,
  });
};

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");
