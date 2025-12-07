import type {
  CompiledExpression,
  ExpressionCompiler,
  ExpressionCompilerParams,
} from "../context.js";
import { compileCallExpr } from "./calls.js";
import { compileBlockExpr } from "./blocks.js";
import {
  compileIfExpr,
  compileMatchExpr,
  compileWhileExpr,
} from "./control-flow.js";
import { compileAssignExpr } from "./mutations.js";
import {
  compileFieldAccessExpr,
  compileObjectLiteralExpr,
  compileTupleExpr,
} from "./objects.js";
import { compileLambdaExpr } from "./lambdas.js";
import {
  compileIdentifierExpr,
  compileLiteralExpr,
} from "./primitives.js";

export const compileExpression: ExpressionCompiler = ({
  exprId,
  ctx,
  fnCtx,
  tailPosition = false,
  expectedResultTypeId,
}: ExpressionCompilerParams): CompiledExpression => {
  if (fnCtx.resumeFromSite && exprId === fnCtx.resumeFromSite.exprId) {
    const resumeFromSite = fnCtx.resumeFromSite;
    fnCtx.resumeFromSite = undefined;
    if (resumeFromSite.resumeLocal) {
      const binding = resumeFromSite.resumeLocal;
      return {
        expr: ctx.mod.local.get(binding.index, binding.type),
        usedReturnCall: false,
      };
    }
    return { expr: ctx.mod.nop(), usedReturnCall: false };
  }

  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    throw new Error(`codegen missing HirExpression ${exprId}`);
  }

  switch (expr.exprKind) {
    case "literal":
      return compileLiteralExpr(expr, ctx);
    case "identifier":
      return compileIdentifierExpr(expr, ctx, fnCtx);
    case "overload-set":
      throw new Error("overload sets cannot be evaluated directly");
    case "call":
      return compileCallExpr(expr, ctx, fnCtx, compileExpression, {
        tailPosition,
        expectedResultTypeId,
      });
    case "block":
      return compileBlockExpr(
        expr,
        ctx,
        fnCtx,
        compileExpression,
        tailPosition,
        expectedResultTypeId
      );
    case "if":
      return compileIfExpr(
        expr,
        ctx,
        fnCtx,
        compileExpression,
        tailPosition,
        expectedResultTypeId
      );
    case "match":
      return compileMatchExpr(
        expr,
        ctx,
        fnCtx,
        compileExpression,
        tailPosition,
        expectedResultTypeId
      );
    case "while":
      return compileWhileExpr(expr, ctx, fnCtx, compileExpression);
    case "assign":
      return compileAssignExpr(expr, ctx, fnCtx, compileExpression);
    case "object-literal":
      return compileObjectLiteralExpr(expr, ctx, fnCtx, compileExpression);
    case "field-access":
      return compileFieldAccessExpr(expr, ctx, fnCtx, compileExpression);
    case "tuple":
      return compileTupleExpr(expr, ctx, fnCtx, compileExpression);
    case "lambda":
      return compileLambdaExpr(expr, ctx, fnCtx, compileExpression);
    default:
      throw new Error(
        `codegen does not support ${expr.exprKind} expressions yet`
      );
  }
};
