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
import { coerceValueToType, storeValueIntoStorageRef } from "../structural.js";
import {
  getRequiredExprType,
  wasmTypeFor,
} from "../types.js";
import { asStatement, coerceToBinaryenType } from "./utils.js";
import { wrapValueInOutcome } from "../effects/outcome-values.js";
import { handlerCleanupOps } from "../effects/handler-stack.js";
import { tailResumptionExitChecks } from "../effects/tail-resumptions.js";
import { boxSignatureSpillValue } from "../signature-spill.js";

const expressionUsesExpectedResultType = ({
  exprId,
  ctx,
}: {
  exprId: number;
  ctx: CodegenContext;
}): boolean => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr) {
    return false;
  }
  switch (expr.exprKind) {
    case "identifier":
    case "call":
    case "method-call":
    case "block":
    case "if":
    case "match":
    case "effect-handler":
      return true;
    default:
      return false;
  }
};

export const compileBlockExpr = (
  expr: HirBlockExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  tailPosition: boolean,
  expectedResultTypeId?: TypeId
): CompiledExpression => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const blockResultTypeId =
    expectedResultTypeId ?? getRequiredExprType(expr.id, ctx, typeInstanceId);
  const blockResultType = wasmTypeFor(blockResultTypeId, ctx);
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
    const requiredActualType =
      typeof expectedResultTypeId === "number" &&
      !usedReturnCall &&
      expressionUsesExpectedResultType({ exprId: expr.value, ctx })
        ? expectedResultTypeId
        : getRequiredExprType(expr.value, ctx, typeInstanceId);
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
      blockResultType,
      fnCtx,
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
        compileExpr({ exprId: stmt.expr, ctx, fnCtx }).expr,
        fnCtx,
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
        if (fnCtx.returnAbiKind === "out_ref" && fnCtx.returnOutPointer) {
          const storedValue = coerceValueToType({
            value: valueExpr.expr,
            actualType: getRequiredExprType(stmt.value, ctx, typeInstanceId),
            targetType: fnCtx.returnTypeId,
            ctx,
            fnCtx,
          });
          const cleanup = handlerCleanupOps({ ctx, fnCtx });
          const storeReturn = storeValueIntoStorageRef({
            pointer: () =>
              ctx.mod.local.get(
                fnCtx.returnOutPointer!.index,
                fnCtx.returnOutPointer!.storageType,
              ),
            value: storedValue,
            typeId: fnCtx.returnTypeId,
            ctx,
            fnCtx,
          });
          const ops =
            cleanup.length === 0
              ? [storeReturn, ...tailChecks, ctx.mod.return()]
              : [...tailChecks, ...cleanup, storeReturn, ctx.mod.return()];
          return ctx.mod.block(null, ops, binaryen.none);
        }
        if (fnCtx.returnTypeId === ctx.program.primitives.void) {
          const cleanup = handlerCleanupOps({ ctx, fnCtx });
          const valueStmt = asStatement(ctx, valueExpr.expr, fnCtx);
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
        const actualTypeId =
          expressionUsesExpectedResultType({ exprId: stmt.value, ctx })
            ? fnCtx.returnTypeId
            : requiredActualType;
        const coerced = coerceValueToType({
          value: valueExpr.expr,
          actualType: actualTypeId,
          targetType: fnCtx.returnTypeId,
          ctx,
          fnCtx,
        });
        const returnedValue = boxSignatureSpillValue({
          value: coerced,
          typeId: fnCtx.returnTypeId,
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
        if (binaryen.getExpressionType(returnedValue) === binaryen.none) {
          if (cleanup.length === 0) {
            return ctx.mod.block(
              null,
              [returnedValue, ...tailChecks, ctx.mod.return()],
              binaryen.none
            );
          }
          return ctx.mod.block(
            null,
            [...tailChecks, ...cleanup, returnedValue, ctx.mod.return()],
            binaryen.none
          );
        }
        if (cleanup.length === 0) {
          return ctx.mod.block(null, [...tailChecks, ctx.mod.return(returnedValue)], binaryen.none);
        }
        return ctx.mod.block(
          null,
          [...tailChecks, ...cleanup, ctx.mod.return(returnedValue)],
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
