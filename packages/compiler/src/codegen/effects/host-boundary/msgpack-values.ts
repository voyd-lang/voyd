import binaryen from "binaryen";
import { refCast } from "@voyd/lib/binaryen-gc/index.js";
import { findSerializerForType } from "../../serializer.js";
import { wasmTypeFor } from "../../types.js";
import type { CodegenContext } from "../../context.js";
import { ensureMsgPackFunctions } from "./msgpack.js";

export const packMsgPackValueForType = ({
  value,
  typeId,
  msgPackType,
  msgpack,
  ctx,
  label,
  onUnsupported = "trap",
}: {
  value: binaryen.ExpressionRef;
  typeId: number;
  msgPackType: binaryen.Type;
  msgpack: ReturnType<typeof ensureMsgPackFunctions>;
  ctx: CodegenContext;
  label: string;
  onUnsupported?: "trap" | "throw";
}): binaryen.ExpressionRef => {
  const serializer = findSerializerForType(typeId, ctx);
  if (serializer) {
    if (serializer.formatId !== "msgpack") {
      throw new Error(
        `unsupported serializer format for ${label}: ${serializer.formatId}`
      );
    }
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

  if (onUnsupported === "throw") {
    throw new Error(`unsupported msgpack value for ${label}`);
  }
  return ctx.mod.block(null, [ctx.mod.unreachable()], msgPackType);
};

export const unpackMsgPackValueForType = ({
  value,
  typeId,
  msgpack,
  ctx,
  label,
}: {
  value: binaryen.ExpressionRef;
  typeId: number;
  msgpack: ReturnType<typeof ensureMsgPackFunctions>;
  ctx: CodegenContext;
  label: string;
}): binaryen.ExpressionRef => {
  const serializer = findSerializerForType(typeId, ctx);
  if (serializer) {
    if (serializer.formatId !== "msgpack") {
      throw new Error(
        `unsupported serializer format for ${label}: ${serializer.formatId}`
      );
    }
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
  throw new Error(`unsupported msgpack value for ${label}`);
};

