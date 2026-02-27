import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirCallExpr,
  TypeId,
} from "../../context.js";
import type { EffectRowId } from "../../../semantics/ids.js";
import {
  callRef,
  refCast,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import { allocateTempLocal } from "../../locals.js";
import {
  getClosureTypeInfo,
  getExprBinaryenType,
  wasmTypeFor,
} from "../../types.js";
import { buildInstanceSubstitution } from "../../type-substitution.js";
import {
  compileCallArgumentsForParams,
  compileCallArgumentsForParamsWithDetails,
} from "./arguments.js";
import {
  compileCallCalleeExpressionWithTemp,
  currentHandlerValue,
  debugEffects,
} from "./shared.js";
import type { CallParam, CompiledCallArgumentsForParams } from "./types.js";

export const compileClosureCall = ({
  expr,
  calleeTypeId,
  calleeDesc,
  ctx,
  fnCtx,
  compileExpr,
  tailPosition,
  expectedResultTypeId,
}: {
  expr: HirCallExpr;
  calleeTypeId: TypeId;
  calleeDesc: {
    kind: "function";
    parameters: readonly { type: TypeId; label?: string; optional?: boolean }[];
    returnType: TypeId;
    effectRow: EffectRowId;
  };
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  tailPosition: boolean;
  expectedResultTypeId?: TypeId;
}): CompiledExpression => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const substitution = buildInstanceSubstitution({ ctx, typeInstanceId });
  const resolvedCalleeTypeId = substitution
    ? ctx.program.types.substitute(calleeTypeId, substitution)
    : calleeTypeId;

  const resolvedDesc = substitution
    ? ctx.program.types.getTypeDesc(resolvedCalleeTypeId)
    : calleeDesc;
  if (resolvedDesc.kind !== "function") {
    throw new Error("expected function type for closure call");
  }

  const base = getClosureTypeInfo(resolvedCalleeTypeId, ctx);
  const effectful =
    typeof resolvedDesc.effectRow === "number" &&
    !ctx.program.effects.isEmpty(resolvedDesc.effectRow);

  if (effectful && debugEffects()) {
    console.log("[effects] closure call", {
      returnType: resolvedDesc.returnType,
      row: ctx.program.effects.getRow(resolvedDesc.effectRow),
    });
  }

  const closureValue = compileCallCalleeExpressionWithTemp({
    call: expr,
    ctx,
    fnCtx,
    compileExpr,
  });

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

  const args = compileClosureArguments({
    call: expr,
    desc: resolvedDesc,
    ctx,
    fnCtx,
    compileExpr,
  });

  const callArgs = effectful
    ? [
        ctx.mod.local.get(closureTemp.index, base.interfaceType),
        currentHandlerValue(ctx, fnCtx),
        ...args,
      ]
    : [ctx.mod.local.get(closureTemp.index, base.interfaceType), ...args];

  const call = callRef(
    ctx.mod,
    targetFn,
    callArgs as number[],
    base.resultType
  );

  const lowered = effectful
    ? ctx.effectsBackend.lowerEffectfulCallResult({
        callExpr: call,
        callId: expr.id,
        returnTypeId: resolvedDesc.returnType,
        expectedResultTypeId,
        tailPosition,
        typeInstanceId,
        ctx,
        fnCtx,
      })
    : { expr: call, usedReturnCall: false };

  ops.push(lowered.expr);
  return {
    expr:
      ops.length === 1
        ? ops[0]!
        : ctx.mod.block(
            null,
            ops,
            getExprBinaryenType(expr.id, ctx, typeInstanceId)
          ),
    usedReturnCall: lowered.usedReturnCall,
  };
};

export const compileCurriedClosureCall = ({
  expr,
  calleeTypeId,
  ctx,
  fnCtx,
  compileExpr,
  tailPosition,
  expectedResultTypeId,
}: {
  expr: HirCallExpr;
  calleeTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  tailPosition: boolean;
  expectedResultTypeId?: TypeId;
}): CompiledExpression => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const substitution = buildInstanceSubstitution({ ctx, typeInstanceId });

  let currentValue = compileCallCalleeExpressionWithTemp({
    call: expr,
    ctx,
    fnCtx,
    compileExpr,
  });
  let currentTypeId = calleeTypeId;
  let argIndex = 0;

  while (argIndex < expr.args.length) {
    const resolvedCurrentTypeId = substitution
      ? ctx.program.types.substitute(currentTypeId, substitution)
      : currentTypeId;
    const currentDesc = ctx.program.types.getTypeDesc(resolvedCurrentTypeId);
    if (currentDesc.kind !== "function") {
      throw new Error("attempted to call a non-function value");
    }

    const params: CallParam[] = currentDesc.parameters.map((param) => ({
      typeId: param.type,
      label: param.label,
      optional: param.optional,
    }));
    const remainingCall: HirCallExpr = {
      ...expr,
      args: expr.args.slice(argIndex),
    };

    const compileArgsForSlice = (): CompiledCallArgumentsForParams => {
      try {
        return compileCallArgumentsForParamsWithDetails({
          call: remainingCall,
          params,
          ctx,
          fnCtx,
          compileExpr,
          options: {
            typeInstanceId,
            argIndexOffset: argIndex,
            allowTrailingArguments: true,
            allCallArgExprIds: expr.args.map((arg) => arg.expr),
          },
        });
      } catch (error) {
        const signature = currentDesc.parameters
          .map(
            (param) =>
              `${param.label ?? "_"}${param.optional ? "?" : ""}:${param.type}`
          )
          .join(", ");
        throw new Error(
          `curried closure call argument mismatch (call ${expr.id} in ${ctx.moduleId}; stage offset=${argIndex}; signature=(${signature}) -> ${currentDesc.returnType}): ${(error as Error).message}`
        );
      }
    };

    const compiledSlice = compileArgsForSlice();
    if (compiledSlice.consumedArgCount === 0) {
      throw new Error(
        `curried closure call made no argument progress (call ${expr.id} in ${ctx.moduleId}; stage offset=${argIndex})`
      );
    }

    const isFinalSlice = argIndex + compiledSlice.consumedArgCount >= expr.args.length;

    const base = getClosureTypeInfo(resolvedCurrentTypeId, ctx);
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

    const effectful =
      typeof currentDesc.effectRow === "number" &&
      !ctx.program.effects.isEmpty(currentDesc.effectRow);
    if (effectful && debugEffects()) {
      console.log("[effects] curried closure call", {
        returnType: currentDesc.returnType,
        row: ctx.program.effects.getRow(currentDesc.effectRow),
      });
    }

    const returnTypeId = currentDesc.returnType;
    const returnWasmType = wasmTypeFor(returnTypeId, ctx);
    const args = compiledSlice.args;

    const callArgs = effectful
      ? [
          ctx.mod.local.get(closureTemp.index, base.interfaceType),
          currentHandlerValue(ctx, fnCtx),
          ...args,
        ]
      : [ctx.mod.local.get(closureTemp.index, base.interfaceType), ...args];
    const call = callRef(
      ctx.mod,
      targetFn,
      callArgs as number[],
      base.resultType
    );

    const lowered = effectful
      ? ctx.effectsBackend.lowerEffectfulCallResult({
          callExpr: call,
          callId: expr.id,
          returnTypeId,
          expectedResultTypeId: isFinalSlice ? expectedResultTypeId : undefined,
          tailPosition: tailPosition && isFinalSlice,
          typeInstanceId,
          ctx,
          fnCtx,
        })
      : { expr: call, usedReturnCall: false };

    ops.push(lowered.expr);
    currentValue = {
      expr:
        ops.length === 1 ? ops[0]! : ctx.mod.block(null, ops, returnWasmType),
      usedReturnCall: lowered.usedReturnCall,
    };
    currentTypeId = returnTypeId;
    argIndex += compiledSlice.consumedArgCount;
  }

  return currentValue;
};

const compileClosureArguments = ({
  call,
  desc,
  ctx,
  fnCtx,
  compileExpr,
}: {
  call: HirCallExpr;
  desc: {
    parameters: readonly { type: TypeId; label?: string; optional?: boolean }[];
  };
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): binaryen.ExpressionRef[] => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const params: CallParam[] = desc.parameters.map((param) => ({
    typeId: param.type,
    label: param.label,
    optional: param.optional,
  }));

  return compileCallArgumentsForParams({
    call,
    params,
    ctx,
    fnCtx,
    compileExpr,
    options: { typeInstanceId },
  });
};
