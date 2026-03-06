import type { CodegenContext } from "../context.js";
import type { SymbolId } from "../../semantics/ids.js";
import { RESUME_KIND, type ResumeKind } from "./runtime-abi.js";
import type { EffectIdInfo } from "./effect-registry.js";

export const getEffectOpIds = (
  symbol: SymbolId,
  ctx: CodegenContext
): {
  effectId: EffectIdInfo;
  opId: number;
  resumeKind: ResumeKind;
  effectSymbol: SymbolId;
} => {
  const info = ctx.module.effectsInfo.operations.get(symbol);
  if (!info) {
    throw new Error(`codegen missing effect metadata for op ${symbol}`);
  }

  const resumeKind =
    info.resumable === "tail" ? RESUME_KIND.tail : RESUME_KIND.resume;
  const registry = ctx.effectsState.effectRegistry;
  if (!registry) {
    throw new Error("codegen missing effect registry");
  }
  const sourceModuleId = info.sourceModuleId ?? ctx.moduleId;
  const effectId = registry.getEffectId(sourceModuleId, info.localEffectIndex);
  if (!effectId) {
    throw new Error(
      `codegen missing effect id for ${sourceModuleId}:${info.localEffectIndex}`
    );
  }
  return {
    effectId,
    opId: info.opIndex,
    resumeKind,
    effectSymbol: info.effectSymbol,
  };
};
