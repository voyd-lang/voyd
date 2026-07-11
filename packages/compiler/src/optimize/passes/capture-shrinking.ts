import type { HirExpression } from "../../semantics/hir/index.js";
import type { HirExprId, SymbolId } from "../../semantics/ids.js";
import { type ProgramOptimizationPass } from "../pass.js";
import { collectHandlerCaptures } from "./shared.js";

export const closureEnvironmentShrinkingPass: ProgramOptimizationPass = {
  name: "closure-environment-shrinking",
  run(ctx) {
    let changed = false;
    let removedCaptures = 0;

    ctx.ir.modules.forEach((moduleView) => {
      const beforeLambdas = Array.from(
        moduleView.hir.expressions.values(),
      ).filter(
        (expr): expr is Extract<HirExpression, { exprKind: "lambda" }> =>
          expr.exprKind === "lambda",
      );
      const before = beforeLambdas
        .map(
          (expr) =>
            `${expr.id}:${expr.captures.map((capture) => capture.symbol).join(",")}`,
        )
        .join("|");
      const beforeCaptureCount = beforeLambdas.reduce(
        (count, expr) => count + expr.captures.length,
        0,
      );

      ctx.mutateCaptures((mutation) =>
        mutation.recomputeLambdaCaptures(moduleView.moduleId),
      );

      const afterLambdas = Array.from(
        moduleView.hir.expressions.values(),
      ).filter(
        (expr): expr is Extract<HirExpression, { exprKind: "lambda" }> =>
          expr.exprKind === "lambda",
      );
      const after = afterLambdas
        .map(
          (expr) =>
            `${expr.id}:${expr.captures.map((capture) => capture.symbol).join(",")}`,
        )
        .join("|");
      if (before !== after) {
        changed = true;
      }
      const afterCaptureCount = afterLambdas.reduce(
        (count, expr) => count + expr.captures.length,
        0,
      );
      removedCaptures += Math.max(0, beforeCaptureCount - afterCaptureCount);
    });

    return {
      changed,
      metrics: { removed_captures: removedCaptures },
    };
  },
};

export const continuationAndHandlerEnvironmentShrinkingPass: ProgramOptimizationPass =
  {
    name: "continuation-handler-environment-shrinking",
    run(ctx) {
      let changed = false;
      let removedCaptures = 0;

      ctx.ir.modules.forEach((moduleView, moduleId) => {
        const captures = collectHandlerCaptures({
          moduleView,
        });
        const existing = ctx.ir.facts.handlerClauseCaptures.get(moduleId);
        const serialize = (
          value?:
            | ReadonlyMap<HirExprId, ReadonlyMap<number, readonly SymbolId[]>>
            | Map<HirExprId, Map<number, readonly SymbolId[]>>,
        ) =>
          JSON.stringify(
            Array.from(value?.entries() ?? []).map(([exprId, clauses]) => [
              exprId,
              Array.from(clauses.entries()),
            ]),
          );
        if (serialize(existing) !== serialize(captures)) {
          const captureCount = (
            value?: ReadonlyMap<
              HirExprId,
              ReadonlyMap<number, readonly SymbolId[]>
            >,
          ): number =>
            Array.from(value?.values() ?? []).reduce(
              (handlerCount, clauses) =>
                handlerCount +
                Array.from(clauses.values()).reduce(
                  (clauseCount, symbols) => clauseCount + symbols.length,
                  0,
                ),
              0,
            );
          removedCaptures += Math.max(
            0,
            captureCount(existing) - captureCount(captures),
          );
          ctx.mutateCaptures((mutation) =>
            mutation.setHandlerClauseCaptures(moduleId, captures),
          );
          changed = true;
        }
      });

      return { changed, metrics: { removed_captures: removedCaptures } };
    },
  };
