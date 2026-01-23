import type { CodegenContext, FunctionMetadata } from "../../context.js";
import type { TypeId } from "../../../semantics/ids.js";
import { requireFunctionMetaByName } from "../../function-lookup.js";
import { stateFor } from "./state.js";

export type MsgPackFunctions = {
  msgPackTypeId: TypeId;
  encodeValue: FunctionMetadata;
  decodeValue: FunctionMetadata;
  packNull: FunctionMetadata;
  packBool: FunctionMetadata;
  packArray: FunctionMetadata;
  packI32: FunctionMetadata;
  packI64: FunctionMetadata;
  packF32: FunctionMetadata;
  packF64: FunctionMetadata;
  packMap: FunctionMetadata;
  unpackBool: FunctionMetadata;
  unpackArray: FunctionMetadata;
  unpackI32: FunctionMetadata;
  unpackI64: FunctionMetadata;
  unpackF32: FunctionMetadata;
  unpackF64: FunctionMetadata;
  unpackMap: FunctionMetadata;
  arrayWithCapacity: FunctionMetadata;
  arrayPush: FunctionMetadata;
  arrayLength: FunctionMetadata;
  arrayRawStorage: FunctionMetadata;
  mapNew: FunctionMetadata;
  mapSet: FunctionMetadata;
};

const MSGPACK_FUNCS_KEY = Symbol("voyd.effects.hostBoundary.msgpackFunctions");

export const ensureMsgPackFunctions = (
  ctx: CodegenContext
): MsgPackFunctions =>
  stateFor(ctx, MSGPACK_FUNCS_KEY, () => {
    const encodeValue = requireFunctionMetaByName({
      ctx,
      moduleId: "std::msgpack",
      name: "encode_value",
      paramCount: 3,
    });
    const signature = ctx.program.functions.getSignature(
      "std::msgpack",
      encodeValue.symbol
    );
    const msgPackTypeId = signature?.parameters[0]?.typeId;
    if (typeof msgPackTypeId !== "number") {
      throw new Error("std::msgpack::encode_value missing MsgPack parameter");
    }

    return {
      msgPackTypeId,
      encodeValue,
      decodeValue: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "decode_value",
        paramCount: 2,
      }),
      packNull: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "pack_null",
        paramCount: 0,
      }),
      packBool: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "pack_bool",
        paramCount: 1,
      }),
      packArray: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "pack_array",
        paramCount: 1,
      }),
      packI32: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "pack_i32",
        paramCount: 1,
      }),
      packI64: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "pack_i64",
        paramCount: 1,
      }),
      packF32: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "pack_f32",
        paramCount: 1,
      }),
      packF64: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "pack_f64",
        paramCount: 1,
      }),
      packMap: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "pack_map",
        paramCount: 1,
      }),
      unpackBool: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "unpack_bool",
        paramCount: 1,
      }),
      unpackArray: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "unpack_array",
        paramCount: 1,
      }),
      unpackI32: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "unpack_i32",
        paramCount: 1,
      }),
      unpackI64: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "unpack_i64",
        paramCount: 1,
      }),
      unpackF32: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "unpack_f32",
        paramCount: 1,
      }),
      unpackF64: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "unpack_f64",
        paramCount: 1,
      }),
      unpackMap: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "unpack_map",
        paramCount: 1,
      }),
      arrayWithCapacity: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "msgpack_array_with_capacity",
        paramCount: 1,
      }),
      arrayPush: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "msgpack_array_push",
        paramCount: 2,
      }),
      arrayLength: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "msgpack_array_length",
        paramCount: 1,
      }),
      arrayRawStorage: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "msgpack_array_raw_storage",
        paramCount: 1,
      }),
      mapNew: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "msgpack_map_new",
        paramCount: 0,
      }),
      mapSet: requireFunctionMetaByName({
        ctx,
        moduleId: "std::msgpack",
        name: "msgpack_map_set",
        paramCount: 3,
      }),
    };
  });
