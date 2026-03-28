import type {
  CompiledExpression,
  ExpressionCompiler,
  ExpressionCompilerParams,
} from "../context.js";
import { compileCallExpr, compileMethodCallExpr } from "./call/index.js";
import { compileBlockExpr } from "./blocks.js";
import {
  compileBreakExpr,
  compileContinueExpr,
  compileIfExpr,
  compileLoopExpr,
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
import { tryCompileProjectedElementValueExpr } from "../projected-element-views.js";
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
  preserveStorageRefs = false,
  outResultStorageRef,
}: ExpressionCompilerParams): CompiledExpression => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr) {
    throw new Error(`codegen missing HirExpression ${exprId}`);
  }

  switch (expr.exprKind) {
    case "literal":
      return compileLiteralExpr(expr, ctx);
    case "identifier":
      return compileIdentifierExpr(
        expr,
        ctx,
        fnCtx,
        expectedResultTypeId,
        preserveStorageRefs,
      );
    case "overload-set":
      throw new Error("overload sets cannot be evaluated directly");
    case "call": {
      const projected = tryCompileProjectedElementValueExpr({
        exprId,
        ctx,
        fnCtx,
        compileExpr: compileExpression,
        expectedResultTypeId,
      });
      if (projected) {
        return projected;
      }
      return compileCallExpr(expr, ctx, fnCtx, compileExpression, {
        tailPosition,
        expectedResultTypeId,
        outResultStorageRef,
      });
    }
    case "method-call": {
      const projected = tryCompileProjectedElementValueExpr({
        exprId,
        ctx,
        fnCtx,
        compileExpr: compileExpression,
        expectedResultTypeId,
      });
      if (projected) {
        return projected;
      }
      return compileMethodCallExpr(expr, ctx, fnCtx, compileExpression, {
        tailPosition,
        expectedResultTypeId,
        outResultStorageRef,
      });
    }
    case "block":
      return compileBlockExpr(
        expr,
        ctx,
        fnCtx,
        compileExpression,
        tailPosition,
        expectedResultTypeId,
        outResultStorageRef,
      );
    case "if":
      return compileIfExpr(
        expr,
        ctx,
        fnCtx,
        compileExpression,
        tailPosition,
        expectedResultTypeId,
        outResultStorageRef,
      );
    case "match":
      return compileMatchExpr(
        expr,
        ctx,
        fnCtx,
        compileExpression,
        tailPosition,
        expectedResultTypeId,
        outResultStorageRef,
      );
    case "while":
      return compileWhileExpr(expr, ctx, fnCtx, compileExpression);
    case "loop":
      return compileLoopExpr(expr, ctx, fnCtx, compileExpression);
    case "break":
      return compileBreakExpr(expr, ctx, fnCtx, compileExpression);
    case "continue":
      return compileContinueExpr(expr, ctx, fnCtx);
    case "assign":
      return compileAssignExpr(expr, ctx, fnCtx, compileExpression);
    case "object-literal":
      return compileObjectLiteralExpr(
        expr,
        ctx,
        fnCtx,
        compileExpression,
        expectedResultTypeId,
        outResultStorageRef,
      );
    case "field-access":
      return compileFieldAccessExpr(expr, ctx, fnCtx, compileExpression);
    case "tuple":
      return compileTupleExpr(
        expr,
        ctx,
        fnCtx,
        compileExpression,
        expectedResultTypeId,
        outResultStorageRef,
      );
    case "lambda":
      return compileLambdaExpr(expr, ctx, fnCtx, compileExpression);
    case "effect-handler":
      return ctx.effectsBackend.compileEffectHandlerExpr({
        expr,
        ctx,
        fnCtx,
        compileExpr: compileExpression,
        tailPosition,
        expectedResultTypeId,
      });
    default:
      throw new Error(
        `codegen does not support ${expr.exprKind} expressions yet`
      );
  }
};
