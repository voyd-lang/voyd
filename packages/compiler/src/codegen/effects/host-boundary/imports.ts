import binaryen from "binaryen";
import type { CodegenContext } from "../../context.js";
import {
  EFFECTS_MEMORY_EXPORT,
  EFFECTS_MEMORY_INTERNAL,
  LINEAR_MEMORY_EXPORT,
  LINEAR_MEMORY_INTERNAL,
} from "./constants.js";
import { stateFor } from "./state.js";

const LINEAR_MEMORY_KEY = Symbol("voyd.effects.hostBoundary.linearMemory");
const EFFECTS_MEMORY_KEY = Symbol("voyd.effects.hostBoundary.effectsMemory");
const MODULES_WITH_LINEAR_MEMORY = new WeakSet<binaryen.Module>();
const MODULES_WITH_EFFECTS_MEMORY = new WeakSet<binaryen.Module>();

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
