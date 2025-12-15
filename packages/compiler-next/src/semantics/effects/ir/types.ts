import type { HirExprId, SymbolId } from "../../ids.js";
import type { EffectOperationRuntimeInfo, EffectsLoweringInfo } from "../analysis.js";

export type EffectsIrCallKind = "perform" | "effectful-call" | "pure-call";

export interface EffectsIrCallNode {
  exprId: HirExprId;
  kind: EffectsIrCallKind;
  calleeSymbol?: SymbolId;
  operation?: EffectOperationRuntimeInfo;
}

export interface EffectsIr {
  info: EffectsLoweringInfo;
  calls: Map<HirExprId, EffectsIrCallNode>;
  handlerExprs: ReadonlySet<HirExprId>;
}

