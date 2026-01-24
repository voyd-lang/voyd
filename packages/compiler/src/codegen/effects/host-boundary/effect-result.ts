import binaryen from "binaryen";
import type { CodegenContext } from "../../context.js";
import type { EffectRuntime } from "../runtime-abi.js";
import { stateFor } from "./state.js";

const EFFECT_STATUS_KEY = Symbol("voyd.effects.hostBoundary.effectStatus");
const EFFECT_CONT_KEY = Symbol("voyd.effects.hostBoundary.effectCont");
const EFFECT_LEN_KEY = Symbol("voyd.effects.hostBoundary.effectLen");

export const ensureEffectResultAccessors = ({
  ctx,
  runtime,
}: {
  ctx: CodegenContext;
  runtime: EffectRuntime;
}): { status: string; cont: string; len: string } => {
  const status = stateFor(ctx, EFFECT_STATUS_KEY, () => {
    const name = `${ctx.moduleLabel}__effect_status`;
    ctx.mod.addFunction(
      name,
      binaryen.createType([runtime.effectResultType]),
      binaryen.i32,
      [],
      runtime.effectResultStatus(ctx.mod.local.get(0, runtime.effectResultType))
    );
    ctx.mod.addFunctionExport(name, "effect_status");
    return name;
  });

  const cont = stateFor(ctx, EFFECT_CONT_KEY, () => {
    const name = `${ctx.moduleLabel}__effect_cont`;
    ctx.mod.addFunction(
      name,
      binaryen.createType([runtime.effectResultType]),
      binaryen.anyref,
      [],
      runtime.effectResultCont(ctx.mod.local.get(0, runtime.effectResultType))
    );
    ctx.mod.addFunctionExport(name, "effect_cont");
    return name;
  });

  const len = stateFor(ctx, EFFECT_LEN_KEY, () => {
    const name = `${ctx.moduleLabel}__effect_len`;
    ctx.mod.addFunction(
      name,
      binaryen.createType([runtime.effectResultType]),
      binaryen.i32,
      [],
      runtime.effectResultLen(ctx.mod.local.get(0, runtime.effectResultType))
    );
    ctx.mod.addFunctionExport(name, "effect_len");
    return name;
  });

  return { status, cont, len };
};
