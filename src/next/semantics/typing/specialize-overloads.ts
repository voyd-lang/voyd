import type {
  HirExpression,
  HirGraph,
  HirIdentifierExpr,
} from "../hir/index.js";
import type { HirExprId } from "../ids.js";
import type { TypingResult } from "./typing.js";

export const specializeOverloadCallees = (
  hir: HirGraph,
  typing: TypingResult
): void => {
  const expressions = hir.expressions as Map<HirExprId, HirExpression>;
  const unspecialized = new Set<HirExprId>();

  for (const expr of expressions.values()) {
    if (expr.exprKind !== "call") continue;
    const callee = expressions.get(expr.callee);
    if (!callee || callee.exprKind !== "overload-set") {
      continue;
    }

    const targets = typing.callTargets.get(expr.id);
    if (!targets || targets.size === 0) {
      throw new Error(
        `missing overload resolution for call expression ${expr.id}`
      );
    }

    const uniqueTargets = new Set(targets.values());
    if (uniqueTargets.size > 1) {
      unspecialized.add(callee.id);
      continue;
    }

    const [target] = uniqueTargets;
    if (typeof target !== "number") {
      throw new Error(
        `missing overload resolution for call expression ${expr.id}`
      );
    }

    const replacement: HirIdentifierExpr = {
      kind: "expr",
      exprKind: "identifier",
      id: callee.id,
      ast: callee.ast,
      span: callee.span,
      typeHint: callee.typeHint,
      symbol: target,
    };

    expressions.set(callee.id, replacement);
  }

  const remaining = Array.from(expressions.values()).find(
    (expr) => expr.exprKind === "overload-set" && !unspecialized.has(expr.id)
  );
  if (remaining) {
    throw new Error(
      `overload set ${remaining.id} was not eliminated during specialization`
    );
  }
};
