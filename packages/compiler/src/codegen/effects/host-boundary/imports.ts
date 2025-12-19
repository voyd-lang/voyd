import binaryen from "binaryen";
import type { CodegenContext } from "../../context.js";
import {
  MSGPACK_READ_VALUE,
  MSGPACK_WRITE_EFFECT,
  MSGPACK_WRITE_VALUE,
} from "./constants.js";
import type { MsgPackImports } from "./types.js";
import { stateFor } from "./state.js";

const LINEAR_MEMORY_KEY = Symbol("voyd.effects.hostBoundary.linearMemory");
const MSGPACK_IMPORTS_KEY = Symbol("voyd.effects.hostBoundary.msgpackImports");

export const ensureLinearMemory = (ctx: CodegenContext): void => {
  stateFor(ctx, LINEAR_MEMORY_KEY, () => {
    ctx.mod.setMemory(1, 1, "memory");
    return true;
  });
};

export const ensureMsgPackImports = (ctx: CodegenContext): MsgPackImports =>
  stateFor(ctx, MSGPACK_IMPORTS_KEY, () => {
    const params = binaryen.createType([
      binaryen.i32,
      binaryen.i64,
      binaryen.i32,
      binaryen.i32,
    ]);
    ctx.mod.addFunctionImport(
      MSGPACK_WRITE_VALUE,
      "env",
      MSGPACK_WRITE_VALUE,
      params,
      binaryen.i32
    );

    const effectParams = binaryen.createType([
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
    ]);
    ctx.mod.addFunctionImport(
      MSGPACK_WRITE_EFFECT,
      "env",
      MSGPACK_WRITE_EFFECT,
      effectParams,
      binaryen.i32
    );

    const readParams = binaryen.createType([
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
    ]);
    ctx.mod.addFunctionImport(
      MSGPACK_READ_VALUE,
      "env",
      MSGPACK_READ_VALUE,
      readParams,
      binaryen.i64
    );

    return {
      writeValue: MSGPACK_WRITE_VALUE,
      writeEffect: MSGPACK_WRITE_EFFECT,
      readValue: MSGPACK_READ_VALUE,
    };
  });
