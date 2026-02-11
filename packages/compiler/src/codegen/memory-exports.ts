import binaryen from "binaryen";
import type { CodegenContext } from "./context.js";
import {
  EFFECTS_MEMORY_EXPORT,
  EFFECTS_MEMORY_INTERNAL,
  LINEAR_MEMORY_EXPORT,
  LINEAR_MEMORY_INTERNAL,
} from "./effects/host-boundary/constants.js";

const MODULES_WITH_LINEAR_MEMORY_EXPORT = new WeakSet<binaryen.Module>();
const MODULES_WITH_EFFECTS_MEMORY_EXPORT = new WeakSet<binaryen.Module>();

const shouldExport = ({
  mode,
  requestedByAuto,
}: {
  mode: "always" | "auto" | "off";
  requestedByAuto: boolean;
}): boolean => mode === "always" || (mode === "auto" && requestedByAuto);

const addLinearMemoryExport = (ctx: CodegenContext): void => {
  if (MODULES_WITH_LINEAR_MEMORY_EXPORT.has(ctx.mod)) {
    return;
  }
  ctx.mod.addMemoryExport(LINEAR_MEMORY_INTERNAL, LINEAR_MEMORY_EXPORT);
  MODULES_WITH_LINEAR_MEMORY_EXPORT.add(ctx.mod);
};

const addEffectsMemoryExport = (ctx: CodegenContext): void => {
  if (MODULES_WITH_EFFECTS_MEMORY_EXPORT.has(ctx.mod)) {
    return;
  }
  ctx.mod.addMemoryExport(EFFECTS_MEMORY_INTERNAL, EFFECTS_MEMORY_EXPORT);
  MODULES_WITH_EFFECTS_MEMORY_EXPORT.add(ctx.mod);
};

export const applyConfiguredMemoryExports = (ctx: CodegenContext): void => {
  if (ctx.options.linearMemoryExport === "always") {
    addLinearMemoryExport(ctx);
  }
  if (ctx.options.effectsMemoryExport === "always") {
    addLinearMemoryExport(ctx);
    addEffectsMemoryExport(ctx);
  }
};

export const ensureLinearMemoryExport = (ctx: CodegenContext): void => {
  if (
    !shouldExport({
      mode: ctx.options.linearMemoryExport,
      requestedByAuto: true,
    })
  ) {
    return;
  }
  addLinearMemoryExport(ctx);
};

export const ensureEffectsMemoryExport = (ctx: CodegenContext): void => {
  if (
    !shouldExport({
      mode: ctx.options.effectsMemoryExport,
      requestedByAuto: true,
    })
  ) {
    return;
  }
  addLinearMemoryExport(ctx);
  addEffectsMemoryExport(ctx);
};
