import binaryen from "binaryen";
import type { CodegenContext } from "../context.js";
import { stateFor } from "./host-boundary/state.js";

const EFFECT_READY_KEY = Symbol("voyd.effects.handleTable.ready");
const INIT_EFFECTS_EXPORT = "init_effects";
const EFFECT_READY_GLOBAL = "__voyd_effects_ready";
const EFFECT_HANDLE_TABLE_BASE_GLOBAL = "__voyd_effect_handle_table_base";
const MODULE_HANDLE_TABLE = new WeakMap<
  binaryen.Module,
  { readyGlobal: string; initExport: string; tableBaseGlobal: string }
>();

export const ensureEffectHandleTable = (
  ctx: CodegenContext
): { readyGlobal: string; initExport: string; tableBaseGlobal: string } =>
  stateFor(ctx, EFFECT_READY_KEY, () => {
    const existing = MODULE_HANDLE_TABLE.get(ctx.mod);
    if (existing) {
      return existing;
    }
    ctx.mod.addGlobal(
      EFFECT_READY_GLOBAL,
      binaryen.i32,
      true,
      ctx.mod.i32.const(0)
    );
    ctx.mod.addGlobal(
      EFFECT_HANDLE_TABLE_BASE_GLOBAL,
      binaryen.i32,
      true,
      ctx.mod.i32.const(0)
    );
    ctx.mod.addFunction(
      INIT_EFFECTS_EXPORT,
      binaryen.createType([binaryen.i32]),
      binaryen.none,
      [],
      ctx.mod.block(null, [
        ctx.mod.global.set(
          EFFECT_HANDLE_TABLE_BASE_GLOBAL,
          ctx.mod.local.get(0, binaryen.i32)
        ),
        ctx.mod.global.set(EFFECT_READY_GLOBAL, ctx.mod.i32.const(1)),
        ctx.mod.return(),
      ])
    );
    ctx.mod.addFunctionExport(INIT_EFFECTS_EXPORT, INIT_EFFECTS_EXPORT);

    const table = {
      readyGlobal: EFFECT_READY_GLOBAL,
      initExport: INIT_EFFECTS_EXPORT,
      tableBaseGlobal: EFFECT_HANDLE_TABLE_BASE_GLOBAL,
    };
    MODULE_HANDLE_TABLE.set(ctx.mod, table);
    return table;
  });

export const effectHandlesReady = (ctx: CodegenContext): binaryen.ExpressionRef => {
  ensureEffectHandleTable(ctx);
  return ctx.mod.global.get(EFFECT_READY_GLOBAL, binaryen.i32);
};
