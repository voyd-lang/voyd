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
    const targets = ctx.typing.callTargets.get(expr.id);
    const targetSymbol =
      (fnCtx.instanceKey && targets?.get(fnCtx.instanceKey)) ??
      (targets && targets.size === 1
        ? targets.values().next().value
        : undefined);
    if (typeof targetSymbol !== "number") {
      throw new Error("codegen missing overload resolution for indirect call");
    }
    const targetMeta = getFunctionMetadataForCall({
      symbol: targetSymbol,
      callId: expr.id,
      ctx,
    });
    if (!targetMeta) {
      throw new Error(`codegen cannot call symbol ${targetSymbol}`);
    }
    const args = compileCallArguments(expr, targetMeta, ctx, fnCtx, compileExpr);
    return emitResolvedCall(targetMeta, args, expr.id, ctx, {
      tailPosition,
      expectedResultTypeId,
      instanceKey: fnCtx.instanceKey,
    });
  }

  if (callee.exprKind !== "identifier") {
    throw new Error("codegen only supports direct identifier calls today");
  }

  const symbolRecord = ctx.symbolTable.getSymbol(callee.symbol);
  const intrinsicMetadata = (symbolRecord.metadata ?? {}) as {
    intrinsic?: boolean;
    intrinsicName?: string;
    intrinsicUsesSignature?: boolean;
  };

  const shouldCompileIntrinsic =
    intrinsicMetadata.intrinsic === true &&
    intrinsicMetadata.intrinsicUsesSignature !== true;

  if (shouldCompileIntrinsic) {
    const args = expr.args.map(
      (arg) => compileExpr({ exprId: arg.expr, ctx, fnCtx }).expr
    );
    return {
      expr: compileIntrinsicCall({
        name: intrinsicMetadata.intrinsicName ?? symbolRecord.name,
        call: expr,
        args,
        ctx,
        fnCtx,
        instanceKey: fnCtx.instanceKey,
      }),
      usedReturnCall: false,
    };
  }

  const meta = getFunctionMetadataForCall({
    symbol: callee.symbol,
    callId: expr.id,
    ctx,
  });
  if (!meta) {
    throw new Error(`codegen missing metadata for symbol ${callee.symbol}`);
  }
  const args = compileCallArguments(expr, meta, ctx, fnCtx, compileExpr);
  return emitResolvedCall(meta, args, expr.id, ctx, {
    tailPosition,
    expectedResultTypeId,
    instanceKey: fnCtx.instanceKey,
  });
};

const emitResolvedCall = (
  meta: FunctionMetadata,
  args: readonly binaryen.ExpressionRef[],
  callId: HirExprId,
  ctx: CodegenContext,
  options: CompileCallOptions = {}
): CompiledExpression => {
  const { tailPosition = false, expectedResultTypeId, instanceKey } = options;
  const typeInstanceKey = instanceKey ?? meta.instanceKey;
  const returnTypeId = getRequiredExprType(callId, ctx, typeInstanceKey);
  const expectedTypeId = expectedResultTypeId ?? returnTypeId;

  if (
    tailPosition &&
    !requiresStructuralConversion(returnTypeId, expectedTypeId, ctx)
  ) {
    return {
      expr: ctx.mod.return_call(
        meta.wasmName,
        args as number[],
        getExprBinaryenType(callId, ctx, typeInstanceKey)
      ),
      usedReturnCall: true,
    };
  }

  return {
    expr: ctx.mod.call(
      meta.wasmName,
      args as number[],
      getExprBinaryenType(callId, ctx, typeInstanceKey)
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
    const actualTypeId = getRequiredExprType(
      arg.expr,
      ctx,
      fnCtx.instanceKey
    );
    const value = compileExpr({ exprId: arg.expr, ctx, fnCtx });
    return coerceValueToType({
      value: value.expr,
      actualType: actualTypeId,
      targetType: expectedTypeId,
      ctx,
      fnCtx,
    });
  });
};

const getFunctionMetadataForCall = ({
  symbol,
  callId,
  ctx,
}: {
  symbol: number;
  callId: HirExprId;
  ctx: CodegenContext;
}): FunctionMetadata | undefined => {
  const rawKey = ctx.typing.callInstanceKeys.get(callId);
  const instance = rawKey
    ? ctx.functionInstances.get(scopedInstanceKey(ctx.moduleId, rawKey))
    : undefined;
  if (instance) {
    return instance;
  }
  const metas = ctx.functions.get(functionKey(ctx.moduleId, symbol));
  if (!metas || metas.length === 0) {
    return undefined;
  }
  if (!rawKey) {
    const genericMeta = metas.find((meta) => meta.typeArgs.length === 0);
    if (genericMeta) {
      return genericMeta;
    }
  }
  return metas[0];
};

const functionKey = (moduleId: string, symbol: number): string =>
  `${moduleId}::${symbol}`;

const scopedInstanceKey = (
  moduleId: string,
  instanceKey: string
): string => `${moduleId}::${instanceKey}`;
