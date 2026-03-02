import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirCallExpr,
  SymbolId,
  TypeId,
} from "../../context.js";
import {
  callRef,
  refCast,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import { LOOKUP_METHOD_ACCESSOR, RTT_METADATA_SLOTS } from "../../rtt/index.js";
import { traitDispatchHash } from "../../trait-dispatch-key.js";
import {
  getExprBinaryenType,
  getFunctionRefType,
  getRequiredExprType,
} from "../../types.js";
import { allocateTempLocal } from "../../locals.js";
import { getFunctionMetadataForCall } from "./metadata.js";
import {
  compileCallArgumentsForParams,
  resolveTypedCallArgumentPlan,
  sliceTypedCallArgumentPlan,
} from "./arguments.js";
import {
  currentHandlerValue,
  handlerType,
  hiddenParamOffsetFor,
} from "./shared.js";

export const compileTraitDispatchCall = ({
  expr,
  calleeSymbol,
  calleeModuleId,
  ctx,
  fnCtx,
  compileExpr,
  tailPosition,
  expectedResultTypeId,
}: {
  expr: HirCallExpr;
  calleeSymbol: SymbolId;
  calleeModuleId?: string;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  tailPosition: boolean;
  expectedResultTypeId?: TypeId;
}): CompiledExpression | undefined => {
  if (expr.args.length === 0) {
    return undefined;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const resolvedModuleId = calleeModuleId ?? ctx.moduleId;
  const mapping = ctx.program.traits.getTraitMethodImpl(
    ctx.program.symbols.canonicalIdOf(resolvedModuleId, calleeSymbol)
  );
  if (!mapping) {
    return undefined;
  }

  const receiverTypeId = getRequiredExprType(
    expr.args[0].expr,
    ctx,
    typeInstanceId
  );
  const receiverDesc = ctx.program.types.getTypeDesc(receiverTypeId);
  const receiverTraitSymbol =
    receiverDesc.kind === "trait" ? receiverDesc.owner : undefined;

  if (receiverDesc.kind !== "trait" || receiverTraitSymbol !== mapping.traitSymbol) {
    return undefined;
  }

  const meta = getFunctionMetadataForCall({
    symbol: calleeSymbol,
    callId: expr.id,
    ctx,
    moduleId: resolvedModuleId,
    typeInstanceId,
  });
  if (!meta) {
    return undefined;
  }

  const receiverIndex = hiddenParamOffsetFor(meta);
  const userParamTypes = meta.paramTypes.slice(receiverIndex + 1);
  const wrapperParamTypes = meta.effectful
    ? [handlerType(ctx), ctx.rtt.baseType, ...userParamTypes]
    : [ctx.rtt.baseType, ...userParamTypes];
  const fnRefType = getFunctionRefType({
    params: wrapperParamTypes,
    result: meta.resultType,
    ctx,
    label: "trait_method",
  });

  const receiverValue = compileExpr({
    exprId: expr.args[0].expr,
    ctx,
    fnCtx,
  });

  const receiverTemp = allocateTempLocal(ctx.rtt.baseType, fnCtx);
  const ops: binaryen.ExpressionRef[] = [
    ctx.mod.local.set(receiverTemp.index, receiverValue.expr),
  ];

  const loadReceiver = (): binaryen.ExpressionRef =>
    ctx.mod.local.get(receiverTemp.index, receiverTemp.type);

  const methodTable = structGetFieldValue({
    mod: ctx.mod,
    fieldType: ctx.rtt.methodLookupHelpers.lookupTableType,
    fieldIndex: RTT_METADATA_SLOTS.METHOD_TABLE,
    exprRef: loadReceiver(),
  });

  const accessor = ctx.mod.call(
    LOOKUP_METHOD_ACCESSOR,
    [
      ctx.mod.i32.const(
        traitDispatchHash({
          traitSymbol: mapping.traitSymbol,
          traitMethodSymbol: mapping.traitMethodSymbol,
        })
      ),
      methodTable,
    ],
    binaryen.funcref
  );

  const target = refCast(ctx.mod, accessor, fnRefType);
  const typedPlan = resolveTypedCallArgumentPlan({
    callId: expr.id,
    typeInstanceId,
    ctx,
  });
  const allCallArgExprIds = expr.args.map((arg) => arg.expr);
  const userTypedPlan = typedPlan
    ? sliceTypedCallArgumentPlan({
        typedPlan,
        paramOffset: 1,
        argOffset: 1,
      })
    : undefined;
  const args = [
    loadReceiver(),
    ...compileCallArgumentsForParams({
      call: { ...expr, args: expr.args.slice(1) },
      params: meta.parameters.slice(1),
      ctx,
      fnCtx,
      compileExpr,
      options: {
        typeInstanceId,
        argIndexOffset: 1,
        allCallArgExprIds,
        typedPlan: userTypedPlan,
      },
    }),
  ];

  const callArgs = meta.effectful
    ? [currentHandlerValue(ctx, fnCtx), ...args]
    : args;
  const callExpr = callRef(
    ctx.mod,
    target,
    callArgs as number[],
    meta.resultType
  );

  const lowered = meta.effectful
    ? ctx.effectsBackend.lowerEffectfulCallResult({
        callExpr,
        callId: expr.id,
        returnTypeId: getRequiredExprType(expr.id, ctx, typeInstanceId),
        expectedResultTypeId,
        tailPosition,
        typeInstanceId,
        ctx,
        fnCtx,
      })
    : { expr: callExpr, usedReturnCall: false };

  ops.push(lowered.expr);
  const binaryenResult = getExprBinaryenType(expr.id, ctx, typeInstanceId);
  return {
    expr: ops.length === 1 ? ops[0]! : ctx.mod.block(null, ops, binaryenResult),
    usedReturnCall: lowered.usedReturnCall,
  };
};
