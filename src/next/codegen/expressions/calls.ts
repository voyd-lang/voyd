import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  CompileCallOptions,
  ExpressionCompiler,
  FunctionContext,
  FunctionMetadata,
  HirCallExpr,
  HirExprId,
} from "../context.js";
import { compileIntrinsicCall } from "../intrinsics.js";
import { requiresStructuralConversion, coerceValueToType } from "../structural.js";
import {
  getExprBinaryenType,
  getRequiredExprType,
} from "../types.js";

export const compileCallExpr = (
  expr: HirCallExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  options: CompileCallOptions = {}
): CompiledExpression => {
  const { tailPosition = false, expectedResultTypeId } = options;
  const callee = ctx.hir.expressions.get(expr.callee);
  if (!callee) {
    throw new Error(`codegen missing callee expression ${expr.callee}`);
  }

  if (callee.exprKind === "overload-set") {
    const targetSymbol = ctx.typing.callTargets.get(expr.id);
    if (typeof targetSymbol !== "number") {
      throw new Error("codegen missing overload resolution for indirect call");
    }
    const targetMeta = ctx.functions.get(targetSymbol);
    if (!targetMeta) {
      throw new Error(`codegen cannot call symbol ${targetSymbol}`);
    }
    const args = compileCallArguments(expr, targetMeta, ctx, fnCtx, compileExpr);
    return emitResolvedCall(targetMeta, args, expr.id, ctx, {
      tailPosition,
      expectedResultTypeId,
    });
  }

  if (callee.exprKind !== "identifier") {
    throw new Error("codegen only supports direct identifier calls today");
  }

  const symbolRecord = ctx.symbolTable.getSymbol(callee.symbol);
  const intrinsicMetadata = (symbolRecord.metadata ?? {}) as {
    intrinsic?: boolean;
  };

  if (intrinsicMetadata.intrinsic) {
    const args = expr.args.map((arg) => compileExpr(arg.expr, ctx, fnCtx).expr);
    return {
      expr: compileIntrinsicCall(symbolRecord.name, expr, args, ctx),
      usedReturnCall: false,
    };
  }

  const targetMeta = ctx.functions.get(callee.symbol);
  if (!targetMeta) {
    throw new Error(`codegen missing metadata for symbol ${callee.symbol}`);
  }
  const args = compileCallArguments(expr, targetMeta, ctx, fnCtx, compileExpr);
  return emitResolvedCall(targetMeta, args, expr.id, ctx, {
    tailPosition,
    expectedResultTypeId,
  });
};

const emitResolvedCall = (
  meta: FunctionMetadata,
  args: readonly binaryen.ExpressionRef[],
  callId: HirExprId,
  ctx: CodegenContext,
  options: CompileCallOptions = {}
): CompiledExpression => {
  const { tailPosition = false, expectedResultTypeId } = options;
  const returnTypeId = getRequiredExprType(callId, ctx);
  const expectedTypeId = expectedResultTypeId ?? returnTypeId;

  if (
    tailPosition &&
    !requiresStructuralConversion(returnTypeId, expectedTypeId, ctx)
  ) {
    return {
      expr: ctx.mod.return_call(
        meta.wasmName,
        args as number[],
        getExprBinaryenType(callId, ctx)
      ),
      usedReturnCall: true,
    };
  }

  return {
    expr: ctx.mod.call(
      meta.wasmName,
      args as number[],
      getExprBinaryenType(callId, ctx)
    ),
    usedReturnCall: false,
  };
};

const compileCallArguments = (
  call: HirCallExpr,
  meta: FunctionMetadata,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): binaryen.ExpressionRef[] => {
  return call.args.map((arg, index) => {
    const expectedTypeId = meta.paramTypeIds[index];
    const actualTypeId = getRequiredExprType(arg.expr, ctx);
    const value = compileExpr(arg.expr, ctx, fnCtx);
    return coerceValueToType(
      value.expr,
      actualTypeId,
      expectedTypeId,
      ctx,
      fnCtx
    );
  });
};
