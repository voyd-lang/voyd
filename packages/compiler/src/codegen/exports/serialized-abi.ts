import binaryen from "binaryen";
import { arrayGet, initDefaultStruct } from "@voyd-lang/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  FunctionContext,
  FunctionMetadata,
  TypeId,
} from "../context.js";
import { findSerializerForType } from "../serializer.js";
import {
  coerceValueToType,
  initStructuralValue,
  liftHeapValueToInline,
  lowerValueForHeapField,
  storeValueIntoStorageRef,
} from "../structural.js";
import {
  abiTypeFor,
  getSignatureSpillBoxType,
  getStructuralTypeInfo,
  wasmTypeFor,
} from "../types.js";
import { ensureLinearMemoryExport } from "../memory-exports.js";
import { ensureMsgPackFunctions } from "../effects/host-boundary/msgpack.js";
import { deriveBoundarySchema } from "../boundary/schema.js";
import {
  packBoundaryValueAsMsgPack,
  unpackBoundaryValueFromMsgPack,
} from "../boundary/msgpack-codec.js";
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
  boundaryMsgPackPayloadField,
  isBoundaryMsgPackValue,
} from "../boundary-metadata.js";
import { compileOptionalNoneValue } from "../optionals.js";

export type SerializedExportTypeAdapter = {
  acceptsType?: (params: {
    typeId: TypeId;
    ctx: CodegenContext;
  }) => boolean;
  packResultValue?: (params: {
    value: binaryen.ExpressionRef;
    typeId: TypeId;
    ctx: CodegenContext;
    fnCtx: FunctionContext;
    exportName: string;
  }) => binaryen.ExpressionRef | undefined;
};

export const emitSerializedExportWrapper = ({
  ctx,
  meta,
  exportName,
  wrapperExportName = exportName,
  typeAdapter,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
  exportName: string;
  wrapperExportName?: string;
  typeAdapter?: SerializedExportTypeAdapter;
}): { wrapperName: string; formatId: "msgpack" } => {
  ensureLinearMemoryExport(ctx);
  validateExportTypes({ ctx, meta, exportName, typeAdapter });

  const msgpack = ensureMsgPackFunctions(ctx);
  const msgPackType = wasmTypeFor(msgpack.msgPackTypeId, ctx);
  const arrayType = msgpack.arrayWithCapacity.resultType;
  const storageType = msgpack.arrayRawStorage.resultType;

  const wrapperName = `${meta.wasmName}__serialized_export_${sanitizeIdentifier(exportName)}`;
  const paramCount = 4;
  const params = binaryen.createType([
    binaryen.i32,
    binaryen.i32,
    binaryen.i32,
    binaryen.i32,
  ]);
  const locals: binaryen.Type[] = [
    msgPackType, // decodedLocal
    arrayType, // argsArrayLocal
    storageType, // storageLocal
    binaryen.i32, // argsCountLocal
  ];
  const argsPtrLocal = 0;
  const argsLenLocal = 1;
  const outPtrLocal = 2;
  const outLenLocal = 3;
  const decodedLocal = 4;
  const argsArrayLocal = 5;
  const storageLocal = 6;
  const argsCountLocal = 7;
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
    msgpack.decodeValue.wasmName,
    [
      ctx.mod.local.get(argsPtrLocal, binaryen.i32),
      ctx.mod.local.get(argsLenLocal, binaryen.i32),
    ],
    msgPackType
  );

  const argsArray = ctx.mod.call(
    msgpack.unpackArray.wasmName,
    [ctx.mod.local.get(decodedLocal, msgPackType)],
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

  const buildParamExpr = (typeId: number, index: number): binaryen.ExpressionRef => {
    const element = arrayGet(
      ctx.mod,
      ctx.mod.local.get(storageLocal, storageType),
      ctx.mod.i32.const(index),
      msgPackType,
      false
    );
    const serializer = findSerializerForType(typeId, ctx);
    if (serializer) {
      if (serializer.formatId !== "msgpack") {
        throw new Error(
          `unsupported export serializer format for ${exportName}: ${serializer.formatId}`
        );
      }
      return coerceValueToType({
        value: element,
        actualType: msgpack.msgPackTypeId,
        targetType: typeId,
        ctx,
        fnCtx,
      });
    }
    if (isBoundaryMsgPackValue(typeId, ctx)) {
      return coerceValueToType({
        value: element,
        actualType: msgpack.msgPackTypeId,
        targetType: typeId,
        ctx,
        fnCtx,
      });
    }
    const payloadField = boundaryMsgPackPayloadField(typeId, ctx);
    if (payloadField) {
      return buildPayloadEnvelopeParamExpr({
        value: element,
        typeId,
        payloadField,
        ctx,
        fnCtx,
        label: `${exportName} arg${index}`,
      });
    }
    return unpackBoundaryValueFromMsgPack({
      ctx,
      value: element,
      schema: deriveBoundarySchema({
        typeId,
        ctx,
        label: `${exportName} arg${index}`,
      }),
      fnCtx,
    });
  };

  const callArgs = meta.paramTypeIds.map((typeId, index) =>
    buildParamExpr(typeId, index)
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
    typeAdapter,
  });
  const encodedLength = ctx.mod.call(
    msgpack.encodeValue.wasmName,
    [
      encodeValue,
      ctx.mod.local.get(outPtrLocal, binaryen.i32),
      ctx.mod.local.get(outLenLocal, binaryen.i32),
    ],
    binaryen.i32
  );

  ctx.mod.addFunction(
    wrapperName,
    params,
    binaryen.i32,
    locals,
    ctx.mod.block(null, [
      ctx.mod.local.set(decodedLocal, decoded),
      ctx.mod.local.set(argsArrayLocal, argsArray),
      ctx.mod.local.set(storageLocal, storage),
      ctx.mod.local.set(argsCountLocal, argsCount),
      checkArgs,
      ...loweredCall.setup,
      ctx.mod.return(encodedLength),
    ])
  );

  ctx.mod.addFunctionExport(wrapperName, wrapperExportName);
  return { wrapperName: wrapperExportName, formatId: "msgpack" };
};

const buildPayloadEnvelopeParamExpr = ({
  value,
  typeId,
  payloadField,
  ctx,
  fnCtx,
  label,
}: {
  value: binaryen.ExpressionRef;
  typeId: TypeId;
  payloadField: NonNullable<ReturnType<typeof boundaryMsgPackPayloadField>>;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  label: string;
}): binaryen.ExpressionRef => {
  const msgpack = ensureMsgPackFunctions(ctx);
  const structInfo = getStructuralTypeInfo(typeId, ctx);
  if (!structInfo) {
    throw new Error(`boundary payload envelope ${label} is missing structural info`);
  }

  const fieldValues = structInfo.fields.map((field) => {
    if (field.name === payloadField.name) {
      const payload = coerceValueToType({
        value,
        actualType: msgpack.msgPackTypeId,
        targetType: field.typeId,
        ctx,
        fnCtx,
      });
      return structInfo.layoutKind === "value-object"
        ? payload
        : lowerValueForHeapField({
            value: payload,
            typeId: field.typeId,
            targetType: field.heapWasmType,
            ctx,
            fnCtx,
          });
    }

    if (!field.optional) {
      throw new Error(
        `boundary payload envelope ${label} has non-payload field ${field.name}`
      );
    }
    const none = compileOptionalNoneValue({
      targetTypeId: field.typeId,
      ctx,
      fnCtx,
    });
    return structInfo.layoutKind === "value-object"
      ? none
      : lowerValueForHeapField({
          value: none,
          typeId: field.typeId,
          targetType: field.heapWasmType,
          ctx,
          fnCtx,
        });
  });

  return initStructuralValue({ structInfo, fieldValues, ctx });
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
}): { setup: readonly binaryen.ExpressionRef[]; value: binaryen.ExpressionRef } => {
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
      throw new Error(`serialized export ${meta.wasmName} is missing out-ref storage`);
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
      }),
    };
  }

  const rawCall = ctx.mod.call(meta.wasmName, userArgs as number[], meta.resultType);
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
}): { setup: readonly binaryen.ExpressionRef[]; args: readonly binaryen.ExpressionRef[] } => {
  if (abiKind === "readonly_ref" || abiKind === "mutable_ref") {
    if (abiTypes.length !== 1) {
      throw new Error(`serialized ABI call ${wasmName} expected one ref ABI lane`);
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
}): { setup: readonly binaryen.ExpressionRef[]; args: readonly binaryen.ExpressionRef[] } => {
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

  const valueAbiTypes = [...binaryen.expandType(binaryen.getExpressionType(value))];
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
  typeAdapter,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
  exportName: string;
  typeAdapter?: SerializedExportTypeAdapter;
}): void => {
  const allTypes = [...meta.paramTypeIds, meta.resultTypeId];
  allTypes.forEach((typeId, index) => {
    const serializer = findSerializerForType(typeId, ctx);
    if (serializer) {
      if (serializer.formatId !== "msgpack") {
        throw new Error(
          `unsupported serializer format for ${exportName}: ${serializer.formatId}`
        );
      }
      return;
    }
    if (typeAdapter?.acceptsType?.({ typeId, ctx }) === true) {
      return;
    }
    const target = index < meta.paramTypeIds.length ? `parameter ${index + 1}` : "return";
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
  typeAdapter,
}: {
  value: binaryen.ExpressionRef;
  typeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  exportName: string;
  typeAdapter?: SerializedExportTypeAdapter;
}): binaryen.ExpressionRef => {
  const msgpack = ensureMsgPackFunctions(ctx);
  const serializer = findSerializerForType(typeId, ctx);
  if (serializer) {
    if (serializer.formatId !== "msgpack") {
      throw new Error(
        `unsupported serializer format for ${exportName}: ${serializer.formatId}`
      );
    }
    return coerceValueToType({
      value,
      actualType: typeId,
      targetType: msgpack.msgPackTypeId,
      ctx,
      fnCtx,
    });
  }
  const adapted = typeAdapter?.packResultValue?.({
    value,
    typeId,
    ctx,
    fnCtx,
    exportName,
  });
  if (adapted) {
    return adapted;
  }
  return packBoundaryValueAsMsgPack({
    value,
    schema: deriveBoundarySchema({
      typeId,
      ctx,
      label: `${exportName} result`,
    }),
    ctx,
    fnCtx,
  });
};

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");
