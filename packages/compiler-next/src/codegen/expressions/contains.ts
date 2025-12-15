import type {
  CodegenContext,
  HirExprId,
  HirStmtId,
} from "../context.js";

export const exprContainsTarget = (
  exprId: HirExprId,
  target: HirExprId,
  ctx: CodegenContext
): boolean => {
  if (exprId === target) return true;
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) return false;

  switch (expr.exprKind) {
    case "identifier":
    case "literal":
    case "overload-set":
    case "continue":
    case "break":
      return false;
    case "call":
      return (
        exprContainsTarget(expr.callee, target, ctx) ||
        expr.args.some((arg) => exprContainsTarget(arg.expr, target, ctx))
      );
    case "block":
      return (
        expr.statements.some((stmtId) =>
          stmtContainsTarget(stmtId, target, ctx)
        ) ||
        (typeof expr.value === "number" &&
          exprContainsTarget(expr.value, target, ctx))
      );
    case "tuple":
      return expr.elements.some((element) =>
        exprContainsTarget(element, target, ctx)
      );
    case "loop":
      return exprContainsTarget(expr.body, target, ctx);
    case "while":
      return (
        exprContainsTarget(expr.condition, target, ctx) ||
        exprContainsTarget(expr.body, target, ctx)
      );
    case "if":
    case "cond":
      return (
        expr.branches.some(
          (branch) =>
            exprContainsTarget(branch.condition, target, ctx) ||
            exprContainsTarget(branch.value, target, ctx)
        ) ||
        (typeof expr.defaultBranch === "number" &&
          exprContainsTarget(expr.defaultBranch, target, ctx))
      );
    case "match":
      return (
        exprContainsTarget(expr.discriminant, target, ctx) ||
        expr.arms.some(
          (arm) =>
            (typeof arm.guard === "number" &&
              exprContainsTarget(arm.guard, target, ctx)) ||
            exprContainsTarget(arm.value, target, ctx)
        )
      );
    case "object-literal":
      return expr.entries.some((entry) =>
        exprContainsTarget(entry.value, target, ctx)
      );
    case "field-access":
      return exprContainsTarget(expr.target, target, ctx);
    case "assign":
      return (
        (typeof expr.target === "number" &&
          exprContainsTarget(expr.target, target, ctx)) ||
        exprContainsTarget(expr.value, target, ctx)
      );
    case "lambda":
    case "effect-handler":
      return false;
  }
};

export const stmtContainsTarget = (
  stmtId: HirStmtId,
  target: HirExprId,
  ctx: CodegenContext
): boolean => {
  const stmt = ctx.hir.statements.get(stmtId);
  if (!stmt) return false;
  switch (stmt.kind) {
    case "expr-stmt":
      return exprContainsTarget(stmt.expr, target, ctx);
    case "return":
      return (
        typeof stmt.value === "number" &&
        exprContainsTarget(stmt.value, target, ctx)
      );
    case "let":
      return exprContainsTarget(stmt.initializer, target, ctx);
  }
};
