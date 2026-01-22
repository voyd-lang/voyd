import type { HirExpression, HirGraph } from "../../hir/index.js";
import type { HirExprId, SymbolId } from "../../ids.js";
import type { EffectsLoweringInfo } from "../analysis.js";
import type { EffectsIr, EffectsIrCallKind, EffectsIrCallNode } from "./types.js";

const callTarget = (expr: HirExpression | undefined): SymbolId | undefined =>
  expr?.exprKind === "identifier" ? expr.symbol : undefined;

const callKindFor = ({
  callId,
  calleeSymbol,
  info,
}: {
  callId: HirExprId;
  calleeSymbol?: SymbolId;
  info: EffectsLoweringInfo;
}): EffectsIrCallKind => {
  if (typeof calleeSymbol === "number" && info.operations.has(calleeSymbol)) {
    return "perform";
  }
  return info.calls.get(callId)?.effectful ? "effectful-call" : "pure-call";
};

export const buildEffectsIr = ({
  hir,
  info,
}: {
  hir: HirGraph;
  info: EffectsLoweringInfo;
}): EffectsIr => {
  const calls = new Map<HirExprId, EffectsIrCallNode>();
  const handlerExprs = new Set<HirExprId>();

  hir.expressions.forEach((expr) => {
    if (expr.exprKind === "effect-handler") {
      handlerExprs.add(expr.id);
      return;
    }
    if (expr.exprKind !== "call" && expr.exprKind !== "method-call") return;

    const calleeSymbol =
      expr.exprKind === "call"
        ? callTarget(hir.expressions.get(expr.callee))
        : undefined;
    const kind = callKindFor({ callId: expr.id, calleeSymbol, info });
    calls.set(expr.id, {
      exprId: expr.id,
      kind,
      calleeSymbol,
      operation:
        kind === "perform" && typeof calleeSymbol === "number"
          ? info.operations.get(calleeSymbol)
          : undefined,
    });
  });

  return { info, calls, handlerExprs };
};
