import type { CodegenContext } from "../context.js";
import type { SymbolId } from "../../semantics/ids.js";
import { RESUME_KIND, type ResumeKind } from "./runtime-abi.js";
import type { EffectIdInfo } from "./effect-registry.js";
import type { EffectOperationRuntimeInfo } from "../../semantics/effects/analysis.js";

const effectOpInfoFor = (
  symbol: SymbolId,
  ctx: CodegenContext
): { info: EffectOperationRuntimeInfo; moduleId: string } | undefined => {
  const localInfo = ctx.module.effectsInfo.operations.get(symbol);
  if (localInfo) {
    return { info: localInfo, moduleId: ctx.moduleId };
  }

  const canonical = ctx.program.symbols.canonicalIdOf(ctx.moduleId, symbol);
  const ref = ctx.program.symbols.refOf(canonical);
  const canonicalModule = ctx.program.modules.get(ref.moduleId);
  const canonicalInfo = canonicalModule?.effectsInfo.operations.get(ref.symbol);
  return canonicalInfo
    ? { info: canonicalInfo, moduleId: ref.moduleId }
    : undefined;
};

export const getEffectOpIds = (
  symbol: SymbolId,
  ctx: CodegenContext
): {
  effectId: EffectIdInfo;
  opId: number;
  resumeKind: ResumeKind;
  effectSymbol: SymbolId;
} => {
  const resolved = effectOpInfoFor(symbol, ctx);
  if (!resolved) {
    throw new Error(`codegen missing effect metadata for op ${symbol}`);
  }
  const { info, moduleId } = resolved;

  const resumeKind =
    info.resumable === "tail" ? RESUME_KIND.tail : RESUME_KIND.resume;
  const registry = ctx.effectsState.effectRegistry;
  if (!registry) {
    throw new Error("codegen missing effect registry");
  }
  const sourceModuleId = info.sourceModuleId ?? moduleId;
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
