import type { CodegenContext } from "../context.js";
import type { HirExprId, SymbolId } from "../../semantics/ids.js";
import type {
  EffectOperationRuntimeInfo,
  EffectsLoweringCallInfo,
  EffectsLoweringFunctionInfo,
  EffectsLoweringHandlerInfo,
  EffectsLoweringLambdaInfo,
} from "../../semantics/effects/analysis.js";
import { getEffectOpIds } from "./op-ids.js";
import { buildEffectsIr } from "../../semantics/effects/ir/build.js";
import type { EffectsIr, EffectsIrCallKind } from "../../semantics/effects/ir/types.js";

export interface EffectsFacade {
  getIr: () => EffectsIr;
  getFunctionInfo: (symbol: SymbolId) => EffectsLoweringFunctionInfo | undefined;
  getLambdaInfo: (exprId: HirExprId) => EffectsLoweringLambdaInfo | undefined;
  getHandlerInfo: (exprId: HirExprId) => EffectsLoweringHandlerInfo | undefined;
  getCallInfo: (exprId: HirExprId) => EffectsLoweringCallInfo | undefined;
  isEffectOpSymbol: (symbol: SymbolId) => boolean;
  getOperationInfo: (symbol: SymbolId) => EffectOperationRuntimeInfo | undefined;
  callKind: (exprId: HirExprId) => EffectsIrCallKind | undefined;
  getEffectOpIds: (symbol: SymbolId) => ReturnType<typeof getEffectOpIds>;
}

export const effectsFacade = (ctx: CodegenContext): EffectsFacade => {
  const memo = ctx.effectsState.memo;
  const key = "__voyd_effects_facade__";
  const existing = memo.get(key) as EffectsFacade | undefined;
  if (existing) return existing;

  const ensureIr = (): EffectsIr => {
    const irKey = "__voyd_effects_ir__";
    const cached = memo.get(irKey) as EffectsIr | undefined;
    if (cached) return cached;
    const built = buildEffectsIr({ hir: ctx.hir, info: ctx.effectsInfo });
    memo.set(irKey, built);
    return built;
  };

  const facade: EffectsFacade = {
    getIr: () => ensureIr(),
    getFunctionInfo: (symbol) => ctx.effectsInfo.functions.get(symbol),
    getLambdaInfo: (exprId) => ctx.effectsInfo.lambdas.get(exprId),
    getHandlerInfo: (exprId) => ctx.effectsInfo.handlers.get(exprId),
    getCallInfo: (exprId) => ctx.effectsInfo.calls.get(exprId),
    isEffectOpSymbol: (symbol) => ctx.effectsInfo.operations.has(symbol),
    getOperationInfo: (symbol) => ctx.effectsInfo.operations.get(symbol),
    callKind: (exprId) => ensureIr().calls.get(exprId)?.kind,
    getEffectOpIds: (symbol) => getEffectOpIds(symbol, ctx),
  };

  memo.set(key, facade);
  return facade;
};
