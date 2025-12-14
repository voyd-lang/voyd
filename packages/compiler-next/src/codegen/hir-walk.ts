import type { CodegenContext, HirExprId, HirPattern, HirStmtId } from "./context.js";
import type { HirExpression, HirStatement } from "../semantics/hir/index.js";

export type HirWalkAction = "skip" | "stop" | void;

export interface HirWalkVisitor {
  onExpr?: (exprId: HirExprId, expr: HirExpression) => HirWalkAction;
  onStmt?: (stmtId: HirStmtId, stmt: HirStatement) => HirWalkAction;
  onPattern?: (pattern: HirPattern) => HirWalkAction;
}

export const walkHirPattern = ({
  pattern,
  visitor,
}: {
  pattern: HirPattern;
  visitor: HirWalkVisitor;
}): boolean => {
  const action = visitor.onPattern?.(pattern);
  if (action === "stop") return false;
  if (action === "skip") return true;

  switch (pattern.kind) {
    case "identifier":
    case "wildcard":
      return true;
    case "destructure": {
      for (const field of pattern.fields) {
        if (!walkHirPattern({ pattern: field.pattern, visitor })) return false;
      }
      return pattern.spread ? walkHirPattern({ pattern: pattern.spread, visitor }) : true;
    }
    case "tuple":
      return pattern.elements.every((element) =>
        walkHirPattern({ pattern: element, visitor })
      );
    case "type":
      return pattern.binding ? walkHirPattern({ pattern: pattern.binding, visitor }) : true;
  }
};

const walkHirStatement = ({
  stmtId,
  ctx,
  visitor,
  visitLambdaBodies,
}: {
  stmtId: HirStmtId;
  ctx: CodegenContext;
  visitor: HirWalkVisitor;
  visitLambdaBodies: boolean;
}): boolean => {
  const stmt = ctx.hir.statements.get(stmtId);
  if (!stmt) return true;

  const action = visitor.onStmt?.(stmtId, stmt);
  if (action === "stop") return false;
  if (action === "skip") return true;

  switch (stmt.kind) {
    case "let":
      return (
        walkHirPattern({ pattern: stmt.pattern, visitor }) &&
        walkHirExpression({ exprId: stmt.initializer, ctx, visitor, visitLambdaBodies })
      );
    case "expr-stmt":
      return walkHirExpression({ exprId: stmt.expr, ctx, visitor, visitLambdaBodies });
    case "return":
      return typeof stmt.value === "number"
        ? walkHirExpression({ exprId: stmt.value, ctx, visitor, visitLambdaBodies })
        : true;
  }
};

export const walkHirExpression = ({
  exprId,
  ctx,
  visitor,
  visitLambdaBodies = false,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
  visitor: HirWalkVisitor;
  visitLambdaBodies?: boolean;
}): boolean => {
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) return true;

  const action = visitor.onExpr?.(exprId, expr);
  if (action === "stop") return false;
  if (action === "skip") return true;

  switch (expr.exprKind) {
    case "literal":
    case "identifier":
    case "overload-set":
    case "continue":
      return true;
    case "break":
      return typeof expr.value === "number"
        ? walkHirExpression({ exprId: expr.value, ctx, visitor, visitLambdaBodies })
        : true;
    case "lambda":
      return visitLambdaBodies
        ? walkHirExpression({ exprId: expr.body, ctx, visitor, visitLambdaBodies })
        : true;
    case "block": {
      for (const stmtId of expr.statements) {
        if (!walkHirStatement({ stmtId, ctx, visitor, visitLambdaBodies })) return false;
      }
      return typeof expr.value === "number"
        ? walkHirExpression({ exprId: expr.value, ctx, visitor, visitLambdaBodies })
        : true;
    }
    case "call":
      return (
        walkHirExpression({ exprId: expr.callee, ctx, visitor, visitLambdaBodies }) &&
        expr.args.every((arg) =>
          walkHirExpression({ exprId: arg.expr, ctx, visitor, visitLambdaBodies })
        )
      );
    case "tuple":
      return expr.elements.every((element) =>
        walkHirExpression({ exprId: element, ctx, visitor, visitLambdaBodies })
      );
    case "loop":
      return walkHirExpression({ exprId: expr.body, ctx, visitor, visitLambdaBodies });
    case "while":
      return (
        walkHirExpression({ exprId: expr.body, ctx, visitor, visitLambdaBodies }) &&
        walkHirExpression({ exprId: expr.condition, ctx, visitor, visitLambdaBodies })
      );
    case "cond":
    case "if": {
      for (const branch of expr.branches) {
        if (
          !walkHirExpression({ exprId: branch.condition, ctx, visitor, visitLambdaBodies }) ||
          !walkHirExpression({ exprId: branch.value, ctx, visitor, visitLambdaBodies })
        ) {
          return false;
        }
      }
      return typeof expr.defaultBranch === "number"
        ? walkHirExpression({ exprId: expr.defaultBranch, ctx, visitor, visitLambdaBodies })
        : true;
    }
    case "match": {
      if (!walkHirExpression({ exprId: expr.discriminant, ctx, visitor, visitLambdaBodies })) {
        return false;
      }
      for (const arm of expr.arms) {
        if (
          (typeof arm.guard === "number" &&
            !walkHirExpression({ exprId: arm.guard, ctx, visitor, visitLambdaBodies })) ||
          !walkHirExpression({ exprId: arm.value, ctx, visitor, visitLambdaBodies })
        ) {
          return false;
        }
      }
      return true;
    }
    case "object-literal":
      return expr.entries.every((entry) =>
        walkHirExpression({ exprId: entry.value, ctx, visitor, visitLambdaBodies })
      );
    case "field-access":
      return walkHirExpression({ exprId: expr.target, ctx, visitor, visitLambdaBodies });
    case "assign":
      return (
        (typeof expr.target !== "number" ||
          walkHirExpression({ exprId: expr.target, ctx, visitor, visitLambdaBodies })) &&
        walkHirExpression({ exprId: expr.value, ctx, visitor, visitLambdaBodies }) &&
        (!expr.pattern || walkHirPattern({ pattern: expr.pattern, visitor }))
      );
    case "effect-handler":
      return (
        walkHirExpression({ exprId: expr.body, ctx, visitor, visitLambdaBodies }) &&
        (typeof expr.finallyBranch !== "number" ||
          walkHirExpression({ exprId: expr.finallyBranch, ctx, visitor, visitLambdaBodies }))
      );
  }
};
