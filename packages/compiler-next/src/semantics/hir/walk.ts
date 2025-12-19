import type { HirExprId, HirStmtId } from "../ids.js";
import type { HirGraph } from "./builder.js";
import type { HirExpression, HirStatement } from "./nodes.js";

type WalkOptions = {
  skipEffectHandlers?: boolean;
};

export const walkExpression = ({
  exprId,
  hir,
  onExpression,
  onStatement,
  options,
}: {
  exprId: HirExprId;
  hir: HirGraph;
  onExpression?: (exprId: HirExprId, expr: HirExpression) => void;
  onStatement?: (stmtId: HirStmtId, stmt: HirStatement) => void;
  options?: WalkOptions;
}): void => {
  const visitExpression = (id: HirExprId): void => {
    const expr = hir.expressions.get(id);
    if (!expr) {
      throw new Error(`missing HirExpression ${id}`);
    }
    onExpression?.(id, expr);

    switch (expr.exprKind) {
      case "literal":
      case "identifier":
      case "overload-set":
      case "continue":
        return;
      case "break":
        if (typeof expr.value === "number") {
          visitExpression(expr.value);
        }
        return;
      case "lambda":
        visitExpression(expr.body);
        return;
      case "effect-handler":
        if (options?.skipEffectHandlers) {
          return;
        }
        visitExpression(expr.body);
        expr.handlers.forEach((handler) => visitExpression(handler.body));
        if (typeof expr.finallyBranch === "number") {
          visitExpression(expr.finallyBranch);
        }
        return;
      case "block":
        expr.statements.forEach(visitStatement);
        if (typeof expr.value === "number") {
          visitExpression(expr.value);
        }
        return;
      case "call":
        visitExpression(expr.callee);
        expr.args.forEach((arg) => visitExpression(arg.expr));
        return;
      case "tuple":
        expr.elements.forEach(visitExpression);
        return;
      case "loop":
        visitExpression(expr.body);
        return;
      case "while":
        visitExpression(expr.condition);
        visitExpression(expr.body);
        return;
      case "cond":
      case "if":
        expr.branches.forEach((branch) => {
          visitExpression(branch.condition);
          visitExpression(branch.value);
        });
        if (typeof expr.defaultBranch === "number") {
          visitExpression(expr.defaultBranch);
        }
        return;
      case "match":
        visitExpression(expr.discriminant);
        expr.arms.forEach((arm) => {
          if (typeof arm.guard === "number") {
            visitExpression(arm.guard);
          }
          visitExpression(arm.value);
        });
        return;
      case "object-literal":
        expr.entries.forEach((entry) => visitExpression(entry.value));
        return;
      case "field-access":
        visitExpression(expr.target);
        return;
      case "assign":
        if (typeof expr.target === "number") {
          visitExpression(expr.target);
        }
        visitExpression(expr.value);
        return;
    }
  };

  const visitStatement = (id: HirStmtId): void => {
    const stmt = hir.statements.get(id);
    if (!stmt) {
      throw new Error(`missing HirStatement ${id}`);
    }
    onStatement?.(id, stmt);

    switch (stmt.kind) {
      case "let":
        visitExpression(stmt.initializer);
        return;
      case "expr-stmt":
        visitExpression(stmt.expr);
        return;
      case "return":
        if (typeof stmt.value === "number") {
          visitExpression(stmt.value);
        }
        return;
    }
  };

  visitExpression(exprId);
};
