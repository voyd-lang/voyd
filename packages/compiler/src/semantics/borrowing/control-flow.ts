import type { HirGraph } from "../hir/index.js";
import type { HirExprId } from "../ids.js";

export type ControlFlowExit =
  | "fallthrough"
  | "return"
  | "break"
  | "continue"
  | "diverge";

export const expressionCanFallThrough = (
  exprId: HirExprId,
  hir: HirGraph,
  seen = new Set<HirExprId>(),
): boolean => {
  if (seen.has(exprId)) {
    return true;
  }
  seen.add(exprId);
  const expr = hir.expressions.get(exprId);
  if (!expr) {
    return true;
  }
  if (expr.exprKind === "break" || expr.exprKind === "continue") {
    return false;
  }
  if (expr.exprKind === "block") {
    for (const statementId of expr.statements) {
      const statement = hir.statements.get(statementId);
      if (!statement) {
        continue;
      }
      if (statement.kind === "return") {
        return false;
      }
      const value =
        statement.kind === "let"
          ? statement.initializer
          : statement.expr;
      if (!expressionCanFallThrough(value, hir, new Set(seen))) {
        return false;
      }
    }
    return typeof expr.value !== "number" ||
      expressionCanFallThrough(expr.value, hir, seen);
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    if (typeof expr.defaultBranch !== "number") {
      return true;
    }
    return [
      ...expr.branches.map((branch) => branch.value),
      expr.defaultBranch,
    ].some((value) =>
      expressionCanFallThrough(value, hir, new Set(seen)),
    );
  }
  if (expr.exprKind === "match") {
    return expr.arms.some((arm) =>
      expressionCanFallThrough(arm.value, hir, new Set(seen)),
    );
  }
  return true;
};
