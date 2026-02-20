import binaryen from "binaryen";
import { refCast } from "@voyd/lib/binaryen-gc/index.js";
import { wasmTypeFor } from "../../types.js";
import type { CodegenContext } from "../../context.js";
import { ensureMsgPackFunctions } from "./msgpack.js";
import { hostBoundaryPayloadSupportForType } from "./payload-compatibility.js";

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
  const support = hostBoundaryPayloadSupportForType({ typeId, ctx });
  if (support.supported) {
    if (support.strategy === "serializer-msgpack") {
      return refCast(ctx.mod, value, msgPackType);
    }
    switch (support.primitive) {
      case "bool":
        return ctx.mod.call(msgpack.packBool.wasmName, [value], msgPackType);
      case "i32":
        return ctx.mod.call(msgpack.packI32.wasmName, [value], msgPackType);
      case "i64":
        return ctx.mod.call(msgpack.packI64.wasmName, [value], msgPackType);
      case "f32":
        return ctx.mod.call(msgpack.packF32.wasmName, [value], msgPackType);
      case "f64":
        return ctx.mod.call(msgpack.packF64.wasmName, [value], msgPackType);
      case "void":
        return ctx.mod.call(msgpack.packNull.wasmName, [], msgPackType);
    }
  }

  if (support.reason.kind === "unsupported-serializer-format") {
    throw new Error(
      `unsupported serializer format for ${label}: ${support.reason.formatId}`
    );
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
  const support = hostBoundaryPayloadSupportForType({ typeId, ctx });
  if (support.supported) {
    if (support.strategy === "serializer-msgpack") {
      return refCast(ctx.mod, value, wasmTypeFor(typeId, ctx));
    }
    switch (support.primitive) {
      case "bool":
        return ctx.mod.call(msgpack.unpackBool.wasmName, [value], binaryen.i32);
      case "i32":
        return ctx.mod.call(msgpack.unpackI32.wasmName, [value], binaryen.i32);
      case "i64":
        return ctx.mod.call(msgpack.unpackI64.wasmName, [value], binaryen.i64);
      case "f32":
        return ctx.mod.call(msgpack.unpackF32.wasmName, [value], binaryen.f32);
      case "f64":
        return ctx.mod.call(msgpack.unpackF64.wasmName, [value], binaryen.f64);
      case "void":
        return ctx.mod.nop();
    }
  }

  if (support.reason.kind === "unsupported-serializer-format") {
    throw new Error(
      `unsupported serializer format for ${label}: ${support.reason.formatId}`
    );
  }
  throw new Error(`unsupported msgpack value for ${label}`);
};
