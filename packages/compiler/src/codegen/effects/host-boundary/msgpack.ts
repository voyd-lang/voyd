import type { CodegenContext, FunctionMetadata } from "../../context.js";
import type { ProgramSymbolId, TypeId } from "../../../semantics/ids.js";
import { requireFunctionMetaByName } from "../../function-lookup.js";
import { stateFor } from "./state.js";

const PUBLIC_MSGPACK_MODULE_ID = "std::msgpack";
const RAW_MSGPACK_MODULE_ID = "std::msgpack::fns";

export type MsgPackFunctions = {
  msgPackTypeId: TypeId;
  encodeValue: FunctionMetadata;
  decodeValue: FunctionMetadata;
  makeNull: FunctionMetadata;
  makeBool: FunctionMetadata;
  makeArray: FunctionMetadata;
  makeI32: FunctionMetadata;
  makeI64: FunctionMetadata;
  makeF32: FunctionMetadata;
  makeF64: FunctionMetadata;
  makeMap: FunctionMetadata;
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
const REACHABILITY_STATE = Symbol.for("voyd.codegen.reachabilityState");

type ReachabilityState = {
  symbols?: Set<ProgramSymbolId>;
};

const markReachable = ({
  ctx,
  moduleId,
  symbol,
}: {
  ctx: CodegenContext;
  moduleId: string;
  symbol: number;
}): void => {
  const state = ctx.programHelpers.getHelperState<ReachabilityState>(
    REACHABILITY_STATE,
    () => ({ symbols: new Set<ProgramSymbolId>() }),
  );
  const symbols = state.symbols ?? new Set<ProgramSymbolId>();
  state.symbols = symbols;
  symbols.add(
    ctx.program.symbols.canonicalIdOf(moduleId, symbol) as ProgramSymbolId,
  );
};

export const ensureMsgPackFunctions = (
  ctx: CodegenContext
): MsgPackFunctions =>
  stateFor(ctx, MSGPACK_FUNCS_KEY, () => {
    const encodeValue = requireFunctionMetaByName({
      ctx,
      moduleId: RAW_MSGPACK_MODULE_ID,
      name: "encode_value",
      paramCount: 3,
    });
    const signature = ctx.program.functions.getSignature(
      RAW_MSGPACK_MODULE_ID,
      encodeValue.symbol
    );
    const msgPackTypeId = signature?.parameters[0]?.typeId;
    if (typeof msgPackTypeId !== "number") {
      throw new Error(
        "std::msgpack::fns::encode_value missing MsgPack parameter"
      );
    }

    const msgpack = {
      msgPackTypeId,
      encodeValue,
      decodeValue: requireFunctionMetaByName({
        ctx,
        moduleId: RAW_MSGPACK_MODULE_ID,
        name: "decode_value",
        paramCount: 2,
      }),
      makeNull: requireFunctionMetaByName({
        ctx,
        moduleId: PUBLIC_MSGPACK_MODULE_ID,
        name: "make_null",
        paramCount: 0,
      }),
      makeBool: requireFunctionMetaByName({
        ctx,
        moduleId: PUBLIC_MSGPACK_MODULE_ID,
        name: "make_bool",
        paramCount: 1,
      }),
      makeArray: requireFunctionMetaByName({
        ctx,
        moduleId: PUBLIC_MSGPACK_MODULE_ID,
        name: "make_array",
        paramCount: 1,
      }),
      makeI32: requireFunctionMetaByName({
        ctx,
        moduleId: PUBLIC_MSGPACK_MODULE_ID,
        name: "make_i32",
        paramCount: 1,
      }),
      makeI64: requireFunctionMetaByName({
        ctx,
        moduleId: PUBLIC_MSGPACK_MODULE_ID,
        name: "make_i64",
        paramCount: 1,
      }),
      makeF32: requireFunctionMetaByName({
        ctx,
        moduleId: PUBLIC_MSGPACK_MODULE_ID,
        name: "make_f32",
        paramCount: 1,
      }),
      makeF64: requireFunctionMetaByName({
        ctx,
        moduleId: PUBLIC_MSGPACK_MODULE_ID,
        name: "make_f64",
        paramCount: 1,
      }),
      makeMap: requireFunctionMetaByName({
        ctx,
        moduleId: PUBLIC_MSGPACK_MODULE_ID,
        name: "make_map",
        paramCount: 1,
      }),
      unpackBool: requireFunctionMetaByName({
        ctx,
        moduleId: RAW_MSGPACK_MODULE_ID,
        name: "unpack_bool",
        paramCount: 1,
      }),
      unpackArray: requireFunctionMetaByName({
        ctx,
        moduleId: RAW_MSGPACK_MODULE_ID,
        name: "unpack_array",
        paramCount: 1,
      }),
      unpackI32: requireFunctionMetaByName({
        ctx,
        moduleId: RAW_MSGPACK_MODULE_ID,
        name: "unpack_i32",
        paramCount: 1,
      }),
      unpackI64: requireFunctionMetaByName({
        ctx,
        moduleId: RAW_MSGPACK_MODULE_ID,
        name: "unpack_i64",
        paramCount: 1,
      }),
      unpackF32: requireFunctionMetaByName({
        ctx,
        moduleId: RAW_MSGPACK_MODULE_ID,
        name: "unpack_f32",
        paramCount: 1,
      }),
      unpackF64: requireFunctionMetaByName({
        ctx,
        moduleId: RAW_MSGPACK_MODULE_ID,
        name: "unpack_f64",
        paramCount: 1,
      }),
      unpackMap: requireFunctionMetaByName({
        ctx,
        moduleId: RAW_MSGPACK_MODULE_ID,
        name: "unpack_map",
        paramCount: 1,
      }),
      arrayWithCapacity: requireFunctionMetaByName({
        ctx,
        moduleId: PUBLIC_MSGPACK_MODULE_ID,
        name: "msgpack_array_with_capacity",
        paramCount: 1,
      }),
      arrayPush: requireFunctionMetaByName({
        ctx,
        moduleId: PUBLIC_MSGPACK_MODULE_ID,
        name: "msgpack_array_push",
        paramCount: 2,
      }),
      arrayLength: requireFunctionMetaByName({
        ctx,
        moduleId: PUBLIC_MSGPACK_MODULE_ID,
        name: "msgpack_array_length",
        paramCount: 1,
      }),
      arrayRawStorage: requireFunctionMetaByName({
        ctx,
        moduleId: PUBLIC_MSGPACK_MODULE_ID,
        name: "msgpack_array_raw_storage",
        paramCount: 1,
      }),
      mapNew: requireFunctionMetaByName({
        ctx,
        moduleId: PUBLIC_MSGPACK_MODULE_ID,
        name: "msgpack_map_new",
        paramCount: 0,
      }),
      mapSet: requireFunctionMetaByName({
        ctx,
        moduleId: PUBLIC_MSGPACK_MODULE_ID,
        name: "msgpack_map_set",
        paramCount: 3,
      }),
    };

    [
      msgpack.encodeValue,
      msgpack.decodeValue,
      msgpack.makeNull,
      msgpack.makeBool,
      msgpack.makeArray,
      msgpack.makeI32,
      msgpack.makeI64,
      msgpack.makeF32,
      msgpack.makeF64,
      msgpack.makeMap,
      msgpack.unpackBool,
      msgpack.unpackArray,
      msgpack.unpackI32,
      msgpack.unpackI64,
      msgpack.unpackF32,
      msgpack.unpackF64,
      msgpack.unpackMap,
      msgpack.arrayWithCapacity,
      msgpack.arrayPush,
      msgpack.arrayLength,
      msgpack.arrayRawStorage,
      msgpack.mapNew,
      msgpack.mapSet,
    ].forEach((meta) =>
      markReachable({
        ctx,
        moduleId: meta.moduleId,
        symbol: meta.symbol,
      }),
    );
    const stringNew = requireFunctionMetaByName({
      ctx,
      moduleId: "std::string",
      name: "new_string",
      paramCount: 1,
    });
    markReachable({
      ctx,
      moduleId: stringNew.moduleId,
      symbol: stringNew.symbol,
    });

    return msgpack;
  });
