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
  TypeId,
} from "../context.js";
import { compileIntrinsicCall } from "../intrinsics.js";
import { requiresStructuralConversion, coerceValueToType } from "../structural.js";
import {
  getClosureTypeInfo,
  getExprBinaryenType,
  getRequiredExprType,
} from "../types.js";
import { allocateTempLocal } from "../locals.js";
import { callRef, refCast, structGetFieldValue } from "@voyd/lib/binaryen-gc/index.js";

export const compileCallExpr = (
  expr: HirCallExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  options: CompileCallOptions = {}
): CompiledExpression => {
  const { tailPosition = false, expectedResultTypeId } = options;
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  const callInstanceKey = fnCtx.instanceKey ?? typeInstanceKey;
  const callee = ctx.hir.expressions.get(expr.callee);
  if (!callee) {
    throw new Error(`codegen missing callee expression ${expr.callee}`);
  }

  if (callee.exprKind === "overload-set") {
    const targets = ctx.typing.callTargets.get(expr.id);
    const targetSymbol =
      (callInstanceKey && targets?.get(callInstanceKey)) ??
      (typeInstanceKey && targets?.get(typeInstanceKey)) ??
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
      typeInstanceKey,
    });
  }

  const calleeTypeId = getRequiredExprType(
    expr.callee,
    ctx,
    typeInstanceKey
  );
  const calleeDesc = ctx.typing.arena.get(calleeTypeId);

  if (callee.exprKind === "identifier") {
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
          instanceKey: typeInstanceKey,
        }),
        usedReturnCall: false,
      };
    }

    const meta = getFunctionMetadataForCall({
      symbol: callee.symbol,
      callId: expr.id,
      ctx,
    });
    if (meta) {
      const args = compileCallArguments(expr, meta, ctx, fnCtx, compileExpr);
      return emitResolvedCall(meta, args, expr.id, ctx, {
        tailPosition,
        expectedResultTypeId,
        typeInstanceKey,
      });
    }
  }

  if (calleeDesc.kind === "function") {
    if (expr.args.length > calleeDesc.parameters.length) {
      return compileCurriedClosureCall({
        expr,
        calleeTypeId,
        ctx,
        fnCtx,
        compileExpr,
      });
    }
    return compileClosureCall({
      expr,
      calleeTypeId,
      calleeDesc,
      ctx,
      fnCtx,
      compileExpr,
    });
  }

  throw new Error("codegen only supports function and closure calls today");
};

const emitResolvedCall = (
  meta: FunctionMetadata,
  args: readonly binaryen.ExpressionRef[],
  callId: HirExprId,
  ctx: CodegenContext,
  options: CompileCallOptions = {}
): CompiledExpression => {
  const { tailPosition = false, expectedResultTypeId, typeInstanceKey } =
    options;
  const lookupKey = typeInstanceKey ?? meta.instanceKey;
  const returnTypeId = getRequiredExprType(callId, ctx, lookupKey);
  const expectedTypeId = expectedResultTypeId ?? returnTypeId;

  if (
    tailPosition &&
    !requiresStructuralConversion(returnTypeId, expectedTypeId, ctx)
  ) {
    return {
      expr: ctx.mod.return_call(
        meta.wasmName,
        args as number[],
        getExprBinaryenType(callId, ctx, lookupKey)
      ),
      usedReturnCall: true,
    };
  }

  return {
    expr: ctx.mod.call(
      meta.wasmName,
      args as number[],
      getExprBinaryenType(callId, ctx, lookupKey)
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
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  return call.args.map((arg, index) => {
    const expectedTypeId = meta.paramTypeIds[index];
    const actualTypeId = getRequiredExprType(
      arg.expr,
      ctx,
      typeInstanceKey
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

const compileClosureArguments = (
  call: HirCallExpr,
  desc: {
    parameters: readonly { type: TypeId; label?: string; optional?: boolean }[];
  },
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): binaryen.ExpressionRef[] => {
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  return call.args.map((arg, index) => {
    const expectedTypeId = desc.parameters[index]?.type;
    const actualTypeId = getRequiredExprType(
      arg.expr,
      ctx,
      typeInstanceKey
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

const compileClosureCall = ({
  expr,
  calleeTypeId,
  calleeDesc,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirCallExpr;
  calleeTypeId: TypeId;
  calleeDesc: {
    kind: "function";
    parameters: readonly { type: TypeId; label?: string; optional?: boolean }[];
    returnType: TypeId;
  };
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression => {
  if (expr.args.length !== calleeDesc.parameters.length) {
    throw new Error("call argument count mismatch");
  }

  const base = getClosureTypeInfo(calleeTypeId, ctx);
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  const closureValue = compileExpr({ exprId: expr.callee, ctx, fnCtx });
  const closureTemp = allocateTempLocal(base.interfaceType, fnCtx);
  const ops: binaryen.ExpressionRef[] = [
    ctx.mod.local.set(closureTemp.index, closureValue.expr),
  ];
  const fnField = structGetFieldValue({
    mod: ctx.mod,
    fieldIndex: 0,
    fieldType: binaryen.funcref,
    exprRef: ctx.mod.local.get(closureTemp.index, base.interfaceType),
  });
  const targetFn =
    base.fnRefType === binaryen.funcref
      ? fnField
      : refCast(ctx.mod, fnField, base.fnRefType);
  const args = compileClosureArguments(expr, calleeDesc, ctx, fnCtx, compileExpr);
  const call = callRef(
    ctx.mod,
    targetFn,
    [
      ctx.mod.local.get(closureTemp.index, base.interfaceType),
      ...args,
    ] as number[],
    base.resultType
  );

  ops.push(call);
  return {
    expr:
      ops.length === 1
        ? ops[0]!
        : ctx.mod.block(
            null,
            ops,
            getExprBinaryenType(expr.id, ctx, typeInstanceKey)
          ),
    usedReturnCall: false,
  };
};

const compileCurriedClosureCall = ({
  expr,
  calleeTypeId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirCallExpr;
  calleeTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression => {
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  let currentValue = compileExpr({ exprId: expr.callee, ctx, fnCtx });
  let currentTypeId = calleeTypeId;
  let argIndex = 0;

  while (argIndex < expr.args.length) {
    const currentDesc = ctx.typing.arena.get(currentTypeId);
    if (currentDesc.kind !== "function") {
      throw new Error("attempted to call a non-function value");
    }

    const paramCount = currentDesc.parameters.length;
    const slice = expr.args.slice(argIndex, argIndex + paramCount);
    if (slice.length !== paramCount) {
      throw new Error("call argument count mismatch");
    }

    const base = getClosureTypeInfo(currentTypeId, ctx);
    const closureTemp = allocateTempLocal(base.interfaceType, fnCtx);
    const ops: binaryen.ExpressionRef[] = [
      ctx.mod.local.set(closureTemp.index, currentValue.expr),
    ];

    const fnField = structGetFieldValue({
      mod: ctx.mod,
      fieldIndex: 0,
      fieldType: binaryen.funcref,
      exprRef: ctx.mod.local.get(closureTemp.index, base.interfaceType),
    });
    const targetFn =
      base.fnRefType === binaryen.funcref
        ? fnField
        : refCast(ctx.mod, fnField, base.fnRefType);
    const args = slice.map((arg, index) => {
      const expectedTypeId = currentDesc.parameters[index]?.type;
      const actualTypeId = getRequiredExprType(
        arg.expr,
        ctx,
        typeInstanceKey
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

    const call = callRef(
      ctx.mod,
      targetFn,
      [
        ctx.mod.local.get(closureTemp.index, base.interfaceType),
        ...args,
      ] as number[],
      base.resultType
    );

    ops.push(call);
    currentValue = {
      expr:
        ops.length === 1
          ? ops[0]!
          : ctx.mod.block(null, ops, base.resultType),
      usedReturnCall: false,
    };
    currentTypeId = currentDesc.returnType;
    argIndex += paramCount;
  }

  return currentValue;
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
