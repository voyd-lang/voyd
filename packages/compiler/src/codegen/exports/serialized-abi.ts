import binaryen from "binaryen";
import { arrayGet, refCast } from "@voyd/lib/binaryen-gc/index.js";
import type { CodegenContext, FunctionContext, FunctionMetadata } from "../context.js";
import { findSerializerForType, resolveSerializerForTypes } from "../serializer.js";
import { coerceValueToType } from "../structural.js";
import { wasmTypeFor } from "../types.js";
import { requireFunctionMeta } from "../function-lookup.js";
import { ensureMsgPackFunctions } from "../effects/host-boundary/msgpack.js";

type ExportSerializer = ReturnType<typeof resolveSerializerForTypes>;

export const emitSerializedExportWrapper = ({
  ctx,
  meta,
  exportName,
}: {
  ctx: CodegenContext;
  meta: FunctionMetadata;
  exportName: string;
}): { wrapperName: string; serializer: ExportSerializer } => {
  const serializer = resolveSerializerForTypes(
    [...meta.paramTypeIds, meta.resultTypeId],
    ctx
  );
  if (!serializer) {
    throw new Error(`missing serializer for ${exportName}`);
  }
  if (serializer.formatId !== "msgpack") {
    throw new Error(
      `unsupported export serializer format for ${exportName}: ${serializer.formatId}`
    );
  }
  validateExportTypes({ ctx, meta, exportName });

  const msgpack = ensureMsgPackFunctions(ctx);
  const msgPackType = wasmTypeFor(msgpack.msgPackTypeId, ctx);
  const arrayType = msgpack.arrayWithCapacity.resultType;
  const storageType = msgpack.arrayRawStorage.resultType;

  const encodeMeta = requireFunctionMeta({
    ctx,
    moduleId: serializer.encode.moduleId,
    symbol: serializer.encode.symbol,
  });
  const decodeMeta = requireFunctionMeta({
    ctx,
    moduleId: serializer.decode.moduleId,
    symbol: serializer.decode.symbol,
  });

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
    effectful: false,
  };

  const decoded = ctx.mod.call(
    decodeMeta.wasmName,
    [
      ctx.mod.local.get(argsPtrLocal, binaryen.i32),
      ctx.mod.local.get(argsLenLocal, binaryen.i32),
    ],
    msgPackType
  );
  const decodedValue = coerceValueToType({
    value: decoded,
    actualType: decodeMeta.resultTypeId,
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

  const buildParamExpr = (typeId: number, index: number): binaryen.ExpressionRef => {
    const element = arrayGet(
      ctx.mod,
      ctx.mod.local.get(storageLocal, storageType),
      ctx.mod.i32.const(index),
      msgPackType,
      false
    );
    return decodeValueForType({
      ctx,
      msgpack,
      msgPackType,
      value: element,
      typeId,
      label: `${exportName} arg${index}`,
    });
  };

  const callArgs = meta.paramTypeIds.map((typeId, index) =>
    buildParamExpr(typeId, index)
  );
  const resultValue = ctx.mod.call(
    meta.wasmName,
    callArgs as number[],
    wasmTypeFor(meta.resultTypeId, ctx)
  );
  const msgpackResult = encodeValueForType({
    ctx,
    msgpack,
    msgPackType,
    value: resultValue,
    typeId: meta.resultTypeId,
    label: `${exportName} result`,
  });
  const encodeParamType = encodeMeta.paramTypeIds[0];
  if (typeof encodeParamType !== "number") {
    throw new Error(`missing serializer input type for ${exportName}`);
  }
  const encodeValue = coerceValueToType({
    value: msgpackResult,
    actualType: msgpack.msgPackTypeId,
    targetType: encodeParamType,
    ctx,
    fnCtx,
  });
  const encodedLength = ctx.mod.call(
    encodeMeta.wasmName,
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
      ctx.mod.local.set(decodedLocal, decodedValue),
      ctx.mod.local.set(argsArrayLocal, argsArray),
      ctx.mod.local.set(storageLocal, storage),
      ctx.mod.local.set(argsCountLocal, argsCount),
      checkArgs,
      ctx.mod.return(encodedLength),
    ])
  );

  ctx.mod.addFunctionExport(wrapperName, exportName);
  return { wrapperName, serializer };
};

const encodeValueForType = ({
  ctx,
  msgpack,
  msgPackType,
  value,
  typeId,
  label,
}: {
  ctx: CodegenContext;
  msgpack: ReturnType<typeof ensureMsgPackFunctions>;
  msgPackType: binaryen.Type;
  value: binaryen.ExpressionRef;
  typeId: number;
  label: string;
}): binaryen.ExpressionRef => {
  const serializer = findSerializerForType(typeId, ctx);
  if (serializer) {
    return refCast(ctx.mod, value, msgPackType);
  }
  if (typeId === ctx.program.primitives.bool) {
    return ctx.mod.call(msgpack.packBool.wasmName, [value], msgPackType);
  }
  if (typeId === ctx.program.primitives.i32) {
    return ctx.mod.call(msgpack.packI32.wasmName, [value], msgPackType);
  }
  if (typeId === ctx.program.primitives.i64) {
    return ctx.mod.call(msgpack.packI64.wasmName, [value], msgPackType);
  }
  if (typeId === ctx.program.primitives.f32) {
    return ctx.mod.call(msgpack.packF32.wasmName, [value], msgPackType);
  }
  if (typeId === ctx.program.primitives.f64) {
    return ctx.mod.call(msgpack.packF64.wasmName, [value], msgPackType);
  }
  if (typeId === ctx.program.primitives.void) {
    return ctx.mod.call(msgpack.packNull.wasmName, [], msgPackType);
  }
  throw new Error(`unsupported encoded value for ${label}`);
};

const decodeValueForType = ({
  ctx,
  msgpack,
  msgPackType,
  value,
  typeId,
  label,
}: {
  ctx: CodegenContext;
  msgpack: ReturnType<typeof ensureMsgPackFunctions>;
  msgPackType: binaryen.Type;
  value: binaryen.ExpressionRef;
  typeId: number;
  label: string;
}): binaryen.ExpressionRef => {
  const serializer = findSerializerForType(typeId, ctx);
  if (serializer) {
    return refCast(ctx.mod, value, wasmTypeFor(typeId, ctx));
  }
  if (typeId === ctx.program.primitives.bool) {
    return ctx.mod.call(msgpack.unpackBool.wasmName, [value], binaryen.i32);
  }
  if (typeId === ctx.program.primitives.i32) {
    return ctx.mod.call(msgpack.unpackI32.wasmName, [value], binaryen.i32);
  }
  if (typeId === ctx.program.primitives.i64) {
    return ctx.mod.call(msgpack.unpackI64.wasmName, [value], binaryen.i64);
  }
  if (typeId === ctx.program.primitives.f32) {
    return ctx.mod.call(msgpack.unpackF32.wasmName, [value], binaryen.f32);
  }
  if (typeId === ctx.program.primitives.f64) {
    return ctx.mod.call(msgpack.unpackF64.wasmName, [value], binaryen.f64);
  }
  if (typeId === ctx.program.primitives.void) {
    return ctx.mod.nop();
  }
  throw new Error(`unsupported decoded value for ${label}`);
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
    const serializer = findSerializerForType(typeId, ctx);
    if (serializer) {
      if (serializer.formatId !== "msgpack") {
        throw new Error(
          `unsupported serializer format for ${exportName}: ${serializer.formatId}`
        );
      }
      return;
    }
    const isPrimitive =
      typeId === ctx.program.primitives.bool ||
      typeId === ctx.program.primitives.i32 ||
      typeId === ctx.program.primitives.i64 ||
      typeId === ctx.program.primitives.f32 ||
      typeId === ctx.program.primitives.f64 ||
      typeId === ctx.program.primitives.void;
    if (!isPrimitive) {
      const target = index < meta.paramTypeIds.length ? "parameter" : "return";
      throw new Error(`unsupported ${target} type for ${exportName}`);
    }
  });
};

const sanitizeIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");
