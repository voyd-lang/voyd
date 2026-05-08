import type { CodegenContext } from "../context.js";
import type { EffectRowId, HirExprId, SymbolId } from "../../semantics/ids.js";
import type {
  EffectsLoweringHandlerInfo,
} from "../../semantics/effects/analysis.js";
import { getEffectOpIds } from "./op-ids.js";
import type { EffectsIr, EffectsIrCallKind } from "../../semantics/effects/ir/types.js";

const FACADE_KEY = Symbol("voyd.effects.facade");

export type FunctionAbiInfo = {
  effectRow: EffectRowId;
  typeEffectful: boolean;
  abiEffectful: boolean;
};

export type LambdaAbiInfo = {
  effectfulType: boolean;
  abiEffectful: boolean;
  shouldLower: boolean;
};

export interface EffectsFacade {
  getIr: () => EffectsIr;
  functionAbi: (symbol: SymbolId) => FunctionAbiInfo | undefined;
  lambdaAbi: (exprId: HirExprId) => LambdaAbiInfo | undefined;
  handler: (exprId: HirExprId) => EffectsLoweringHandlerInfo | undefined;
  callKind: (exprId: HirExprId) => EffectsIrCallKind | undefined;
  effectOpIds: (symbol: SymbolId) => ReturnType<typeof getEffectOpIds>;
}

export const effectsFacade = (ctx: CodegenContext): EffectsFacade => {
  const memo = ctx.effectsState.memo;
  const existing = memo.get(FACADE_KEY) as EffectsFacade | undefined;
  if (existing) return existing;

  const facade: EffectsFacade = {
    getIr: () => ctx.module.effectsIr,
    functionAbi: (symbol) => {
      const info = ctx.module.effectsIr.info.functions.get(symbol);
      if (!info) return undefined;
      return {
        effectRow: info.effectRow,
        typeEffectful: info.pure === false,
        abiEffectful: info.abiEffectful,
      };
    },
    lambdaAbi: (exprId) => {
      const info = ctx.module.effectsIr.info.lambdas.get(exprId);
      if (!info) return undefined;
      return {
        effectfulType: info.effectfulType,
        abiEffectful: info.abiEffectful,
        shouldLower: info.shouldLower,
      };
    },
    handler: (exprId) => ctx.module.effectsIr.info.handlers.get(exprId),
    callKind: (exprId) => ctx.module.effectsIr.calls.get(exprId)?.kind,
    effectOpIds: (symbol) => getEffectOpIds(symbol, ctx),
  };

  memo.set(FACADE_KEY, facade);
  return facade;
};
