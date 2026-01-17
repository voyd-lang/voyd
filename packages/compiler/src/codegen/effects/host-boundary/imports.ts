import binaryen from "binaryen";
import type { CodegenContext } from "../../context.js";
import {
  EFFECTS_MEMORY_EXPORT,
  EFFECTS_MEMORY_INTERNAL,
  LINEAR_MEMORY_EXPORT,
  LINEAR_MEMORY_INTERNAL,
  MSGPACK_READ_VALUE,
  MSGPACK_WRITE_EFFECT,
  MSGPACK_WRITE_VALUE,
} from "./constants.js";
import type { MsgPackImports } from "./types.js";
import { stateFor } from "./state.js";

const LINEAR_MEMORY_KEY = Symbol("voyd.effects.hostBoundary.linearMemory");
const EFFECTS_MEMORY_KEY = Symbol("voyd.effects.hostBoundary.effectsMemory");
const MODULES_WITH_LINEAR_MEMORY = new WeakSet<binaryen.Module>();
const MODULES_WITH_EFFECTS_MEMORY = new WeakSet<binaryen.Module>();
const MSGPACK_IMPORTS_KEY = Symbol("voyd.effects.hostBoundary.msgpackImports");

export const ensureLinearMemory = (ctx: CodegenContext): void => {
  stateFor(ctx, LINEAR_MEMORY_KEY, () => {
    if (MODULES_WITH_LINEAR_MEMORY.has(ctx.mod)) {
      return true;
    }
    ctx.mod.addMemoryExport(LINEAR_MEMORY_INTERNAL, LINEAR_MEMORY_EXPORT);
    MODULES_WITH_LINEAR_MEMORY.add(ctx.mod);
    return true;
  });
};

export const ensureEffectsMemory = (ctx: CodegenContext): void => {
  ensureLinearMemory(ctx);
  stateFor(ctx, EFFECTS_MEMORY_KEY, () => {
    if (MODULES_WITH_EFFECTS_MEMORY.has(ctx.mod)) {
      return true;
    }
    ctx.mod.addMemoryExport(EFFECTS_MEMORY_INTERNAL, EFFECTS_MEMORY_EXPORT);
    MODULES_WITH_EFFECTS_MEMORY.add(ctx.mod);
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
      binaryen.i64,
      binaryen.i32,
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
