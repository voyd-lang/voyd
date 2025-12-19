import type { CodegenContext } from "../context.js";
import type { SymbolId } from "../../semantics/ids.js";
import { RESUME_KIND, type ResumeKind } from "./runtime-abi.js";

export const getEffectOpIds = (
  symbol: SymbolId,
  ctx: CodegenContext
): {
  effectId: number;
  opId: number;
  resumeKind: ResumeKind;
  effectSymbol: SymbolId;
} => {
  const info = ctx.effectsInfo.operations.get(symbol);
  if (!info) {
    throw new Error(`codegen missing effect metadata for op ${symbol}`);
  }

  const resumeKind =
    info.resumable === "tail" ? RESUME_KIND.tail : RESUME_KIND.resume;
  return {
    effectId: ctx.effectIdOffset + info.localEffectIndex,
    opId: info.opIndex,
    resumeKind,
    effectSymbol: info.effectSymbol,
  };
};

