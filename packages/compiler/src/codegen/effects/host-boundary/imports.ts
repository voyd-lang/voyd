import type { CodegenContext } from "../../context.js";
import {
  ensureEffectsMemoryExport,
  ensureLinearMemoryExport,
} from "../../memory-exports.js";

export const ensureLinearMemory = (ctx: CodegenContext): void => {
  ensureLinearMemoryExport(ctx);
};

export const ensureEffectsMemory = (ctx: CodegenContext): void => {
  ensureEffectsMemoryExport(ctx);
};
