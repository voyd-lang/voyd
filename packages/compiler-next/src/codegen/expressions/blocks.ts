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
import { exprContainsTarget, stmtContainsTarget } from "./contains.js";

export const compileBlockExpr = (
  expr: HirBlockExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  tailPosition: boolean,
  expectedResultTypeId?: TypeId
): CompiledExpression => {
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  const statements: binaryen.ExpressionRef[] = [];
  const resumeTarget = fnCtx.resumeFromSite?.exprId;
  let foundResume = false;
  expr.statements.forEach((stmtId) => {
    if (foundResume) {
      statements.push(compileStatement(stmtId, ctx, fnCtx, compileExpr));
      return;
    }
    if (
      resumeTarget !== undefined &&
      !stmtContainsTarget(stmtId, resumeTarget, ctx)
    ) {
      return;
    }
    if (resumeTarget !== undefined) {
      foundResume = true;
    }
    statements.push(compileStatement(stmtId, ctx, fnCtx, compileExpr));
  });

  if (typeof expr.value === "number") {
    if (
      resumeTarget !== undefined &&
      !foundResume &&
      !exprContainsTarget(expr.value, resumeTarget, ctx)
    ) {
      return { expr: ctx.mod.nop(), usedReturnCall: false };
    }
    const { expr: valueExpr, usedReturnCall } = compileExpr({
      exprId: expr.value,
      ctx,
      fnCtx,
      tailPosition,
      expectedResultTypeId,
    });
    if (statements.length === 0) {
      return { expr: valueExpr, usedReturnCall };
    }

    statements.push(valueExpr);
    return {
      expr: ctx.mod.block(
        null,
        statements,
        getExprBinaryenType(expr.id, ctx, typeInstanceKey)
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
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  const stmt = ctx.hir.statements.get(stmtId);
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
          typeInstanceKey
        );
        const coerced = coerceValueToType({
          value: valueExpr.expr,
          actualType,
          targetType: fnCtx.returnTypeId,
          ctx,
          fnCtx,
        });
        if (fnCtx.effectful) {
          return ctx.mod.return(
            wrapValueInOutcome({
              valueExpr: coerced,
              valueType: wasmTypeFor(fnCtx.returnTypeId, ctx),
              ctx,
            })
          );
        }
        return ctx.mod.return(coerced);
      }
      if (fnCtx.effectful) {
        return ctx.mod.return(
          wrapValueInOutcome({
            valueExpr: ctx.mod.nop(),
            valueType: wasmTypeFor(fnCtx.returnTypeId, ctx),
            ctx,
          })
        );
      }
      return ctx.mod.return();
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
