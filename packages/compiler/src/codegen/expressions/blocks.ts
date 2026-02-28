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
import { asStatement, coerceToBinaryenType } from "./utils.js";
import { wrapValueInOutcome } from "../effects/outcome-values.js";
import { handlerCleanupOps } from "../effects/handler-stack.js";
import { tailResumptionExitChecks } from "../effects/tail-resumptions.js";

export const compileBlockExpr = (
  expr: HirBlockExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  tailPosition: boolean,
  expectedResultTypeId?: TypeId
): CompiledExpression => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const blockResultType = getExprBinaryenType(expr.id, ctx, typeInstanceId);
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
    const requiredActualType = getRequiredExprType(expr.value, ctx, typeInstanceId);
    const coercedToExpected =
      typeof expectedResultTypeId === "number" && !usedReturnCall
        ? coerceValueToType({
            value: valueExpr,
            actualType: requiredActualType,
            targetType: expectedResultTypeId,
            ctx,
            fnCtx,
          })
        : valueExpr;
    const coerced = coerceToBinaryenType(
      ctx,
      coercedToExpected,
      blockResultType
    );
    if (statements.length === 0) {
      return { expr: coerced, usedReturnCall };
    }

    statements.push(coerced);
    return {
      expr: ctx.mod.block(
        null,
        statements,
        blockResultType
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
        const tailChecks = tailResumptionExitChecks({ ctx, fnCtx });
        if (fnCtx.returnTypeId === ctx.program.primitives.void) {
          const cleanup = handlerCleanupOps({ ctx, fnCtx });
          const valueStmt = asStatement(ctx, valueExpr.expr);
          if (fnCtx.effectful) {
            const wrapped = wrapValueInOutcome({
              valueExpr: ctx.mod.nop(),
              valueType: wasmTypeFor(fnCtx.returnTypeId, ctx),
              ctx,
            });
            const ops =
              cleanup.length === 0
                ? [valueStmt, ...tailChecks, ctx.mod.return(wrapped)]
                : [valueStmt, ...tailChecks, ...cleanup, ctx.mod.return(wrapped)];
            return ctx.mod.block(null, ops, binaryen.none);
          }
          const ops =
            cleanup.length === 0
              ? [valueStmt, ...tailChecks, ctx.mod.return()]
              : [valueStmt, ...tailChecks, ...cleanup, ctx.mod.return()];
          return ctx.mod.block(null, ops, binaryen.none);
        }
        const requiredActualType = getRequiredExprType(
          stmt.value,
          ctx,
          typeInstanceId
        );
        const coerced = coerceValueToType({
          value: valueExpr.expr,
          actualType: requiredActualType,
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
            return ctx.mod.block(null, [...tailChecks, ctx.mod.return(wrapped)], binaryen.none);
          }
          return ctx.mod.block(
            null,
            [...tailChecks, ...cleanup, ctx.mod.return(wrapped)],
            binaryen.none
          );
        }
        if (binaryen.getExpressionType(coerced) === binaryen.none) {
          if (cleanup.length === 0) {
            return ctx.mod.block(
              null,
              [coerced, ...tailChecks, ctx.mod.return()],
              binaryen.none
            );
          }
          return ctx.mod.block(
            null,
            [...tailChecks, ...cleanup, coerced, ctx.mod.return()],
            binaryen.none
          );
        }
        if (cleanup.length === 0) {
          return ctx.mod.block(null, [...tailChecks, ctx.mod.return(coerced)], binaryen.none);
        }
        return ctx.mod.block(
          null,
          [...tailChecks, ...cleanup, ctx.mod.return(coerced)],
          binaryen.none
        );
      }
      const tailChecks = tailResumptionExitChecks({ ctx, fnCtx });
      const cleanup = handlerCleanupOps({ ctx, fnCtx });
      if (fnCtx.effectful) {
        const wrapped = wrapValueInOutcome({
          valueExpr: ctx.mod.nop(),
          valueType: wasmTypeFor(fnCtx.returnTypeId, ctx),
          ctx,
        });
        if (cleanup.length === 0) {
          return ctx.mod.block(null, [...tailChecks, ctx.mod.return(wrapped)], binaryen.none);
        }
        return ctx.mod.block(
          null,
          [...tailChecks, ...cleanup, ctx.mod.return(wrapped)],
          binaryen.none
        );
      }
      if (cleanup.length === 0) {
        return ctx.mod.block(null, [...tailChecks, ctx.mod.return()], binaryen.none);
      }
      return ctx.mod.block(
        null,
        [...tailChecks, ...cleanup, ctx.mod.return()],
        binaryen.none
      );
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
