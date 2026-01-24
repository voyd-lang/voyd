import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirBlockExpr,
  HirLetStatement,
  HirStmtId,
  TypeId,
} from "../context.js";
import { compilePatternInitialization } from "../patterns.js";
import { coerceValueToType } from "../structural.js";
import {
  getExprBinaryenType,
  getRequiredExprType,
  wasmTypeFor,
} from "../types.js";
import { asStatement } from "./utils.js";
import { wrapValueInOutcome } from "../effects/outcome-values.js";
import { handlerCleanupOps } from "../effects/handler-stack.js";

export const compileBlockExpr = (
  expr: HirBlockExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  tailPosition: boolean,
  expectedResultTypeId?: TypeId
): CompiledExpression => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const statements: binaryen.ExpressionRef[] = [];
  expr.statements.forEach((stmtId) => {
    statements.push(compileStatement(stmtId, ctx, fnCtx, compileExpr));
  });

  if (typeof expr.value === "number") {
    const { expr: valueExpr, usedReturnCall } = compileExpr({
      exprId: expr.value,
      ctx,
      fnCtx,
      tailPosition,
      expectedResultTypeId,
    });
    const actualType = getRequiredExprType(expr.value, ctx, typeInstanceId);
    const coerced =
      typeof expectedResultTypeId === "number" && !usedReturnCall
        ? coerceValueToType({
            value: valueExpr,
            actualType,
            targetType: expectedResultTypeId,
            ctx,
            fnCtx,
          })
        : valueExpr;
    if (statements.length === 0) {
      return { expr: coerced, usedReturnCall };
    }

    statements.push(coerced);
    return {
      expr: ctx.mod.block(
        null,
        statements,
        getExprBinaryenType(expr.id, ctx, typeInstanceId)
      ),
      usedReturnCall,
    };
  }

  if (statements.length === 0) {
    return { expr: ctx.mod.nop(), usedReturnCall: false };
  }

  return {
    expr: ctx.mod.block(null, statements, binaryen.none),
    usedReturnCall: false,
  };
};

export const compileStatement = (
  stmtId: HirStmtId,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): binaryen.ExpressionRef => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const stmt = ctx.module.hir.statements.get(stmtId);
  if (!stmt) {
    throw new Error(`codegen missing HirStatement ${stmtId}`);
  }

  switch (stmt.kind) {
    case "expr-stmt":
      return asStatement(
        ctx,
        compileExpr({ exprId: stmt.expr, ctx, fnCtx }).expr
      );
    case "return":
      if (typeof stmt.value === "number") {
        const valueExpr = compileExpr({
          exprId: stmt.value,
          ctx,
          fnCtx,
          tailPosition: true,
          expectedResultTypeId: fnCtx.returnTypeId,
        });
        if (valueExpr.usedReturnCall) {
          return valueExpr.expr;
        }
        const actualType = getRequiredExprType(
          stmt.value,
          ctx,
          typeInstanceId
        );
        const coerced = coerceValueToType({
          value: valueExpr.expr,
          actualType,
          targetType: fnCtx.returnTypeId,
          ctx,
          fnCtx,
        });
        const cleanup = handlerCleanupOps({ ctx, fnCtx });
        if (fnCtx.effectful) {
          const wrapped = wrapValueInOutcome({
            valueExpr: coerced,
            valueType: wasmTypeFor(fnCtx.returnTypeId, ctx),
            ctx,
          });
          if (cleanup.length === 0) {
            return ctx.mod.return(wrapped);
          }
          return ctx.mod.block(
            null,
            [...cleanup, ctx.mod.return(wrapped)],
            binaryen.none
          );
        }
        if (binaryen.getExpressionType(coerced) === binaryen.none) {
          if (cleanup.length === 0) {
            return ctx.mod.block(null, [coerced, ctx.mod.return()], binaryen.none);
          }
          return ctx.mod.block(
            null,
            [...cleanup, coerced, ctx.mod.return()],
            binaryen.none
          );
        }
        if (cleanup.length === 0) {
          return ctx.mod.return(coerced);
        }
        return ctx.mod.block(
          null,
          [...cleanup, ctx.mod.return(coerced)],
          binaryen.none
        );
      }
      const cleanup = handlerCleanupOps({ ctx, fnCtx });
      if (fnCtx.effectful) {
        const wrapped = wrapValueInOutcome({
          valueExpr: ctx.mod.nop(),
          valueType: wasmTypeFor(fnCtx.returnTypeId, ctx),
          ctx,
        });
        if (cleanup.length === 0) {
          return ctx.mod.return(wrapped);
        }
        return ctx.mod.block(
          null,
          [...cleanup, ctx.mod.return(wrapped)],
          binaryen.none
        );
      }
      if (cleanup.length === 0) {
        return ctx.mod.return();
      }
      return ctx.mod.block(null, [...cleanup, ctx.mod.return()], binaryen.none);
    case "let":
      return compileLetStatement(stmt, ctx, fnCtx, compileExpr);
    default:
      throw new Error("codegen cannot lower statement kind");
  }
};

const compileLetStatement = (
  stmt: HirLetStatement,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): binaryen.ExpressionRef => {
  const ops: binaryen.ExpressionRef[] = [];
  compilePatternInitialization({
    pattern: stmt.pattern,
    initializer: stmt.initializer,
    ctx,
    fnCtx,
    ops,
    compileExpr,
    options: { declare: true },
  });
  if (ops.length === 0) {
    return ctx.mod.nop();
  }
  return ctx.mod.block(null, ops, binaryen.none);
};
