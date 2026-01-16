import type { CodegenContext, HirExprId, HirPattern, HirStmtId } from "./context.js";
import {
  walkExpression as walkSemanticsExpression,
  walkPattern as walkSemanticsPattern,
  type HirExpression,
  type HirStatement,
  type WalkControl,
} from "../semantics/index.js";

export type HirWalkAction = "skip" | "stop" | void;

export interface HirWalkVisitor {
  onExpr?: (exprId: HirExprId, expr: HirExpression) => HirWalkAction;
  onStmt?: (stmtId: HirStmtId, stmt: HirStatement) => HirWalkAction;
  onPattern?: (pattern: HirPattern) => HirWalkAction;
}

const handleAction = (
  action: HirWalkAction,
  stop: { value: boolean }
): WalkControl | void => {
  if (action === "stop") {
    stop.value = true;
    return { stop: true };
  }
  if (action === "skip") {
    return { skipChildren: true };
  }
  return undefined;
};

export const walkHirPattern = ({
  pattern,
  visitor,
}: {
  pattern: HirPattern;
  visitor: HirWalkVisitor;
}): boolean => {
  const stop = { value: false };
  walkSemanticsPattern({
    pattern,
    onEnterPattern: (node) => handleAction(visitor.onPattern?.(node), stop),
  });
  return !stop.value;
};

export const walkHirExpression = ({
  exprId,
  ctx,
  visitor,
  visitLambdaBodies = false,
  visitHandlerBodies = false,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
  visitor: HirWalkVisitor;
  visitLambdaBodies?: boolean;
  visitHandlerBodies?: boolean;
}): boolean => {
  const stop = { value: false };
  walkSemanticsExpression({
    exprId,
    hir: ctx.module.hir,
    options: {
      skipLambdas: !visitLambdaBodies,
      visitHandlerBodies,
    },
    onEnterExpression: (id, expr) =>
      handleAction(visitor.onExpr?.(id, expr), stop),
    onEnterStatement: (id, stmt) =>
      handleAction(visitor.onStmt?.(id, stmt), stop),
    onEnterPattern: visitor.onPattern
      ? (pattern) => handleAction(visitor.onPattern?.(pattern), stop)
      : undefined,
  });
  return !stop.value;
};
