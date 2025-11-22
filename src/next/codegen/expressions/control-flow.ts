import binaryen from "binaryen";
import { structGetFieldValue } from "../../../lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirIfExpr,
  HirMatchExpr,
  HirPattern,
  HirWhileExpr,
  LocalBinding,
  TypeId,
} from "../context.js";
import { allocateTempLocal } from "../locals.js";
import { RTT_METADATA_SLOTS } from "../rtt/index.js";
import {
  getExprBinaryenType,
  getRequiredExprType,
  getStructuralTypeInfo,
  resolvePatternTypeForMatch,
} from "../types.js";

export const compileIfExpr = (
  expr: HirIfExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  tailPosition: boolean,
  expectedResultTypeId?: TypeId
): CompiledExpression => {
  const resultType = getExprBinaryenType(expr.id, ctx, fnCtx.instanceKey);
  let fallback =
    typeof expr.defaultBranch === "number"
      ? compileExpr({
          exprId: expr.defaultBranch,
          ctx,
          fnCtx,
          tailPosition,
          expectedResultTypeId,
        })
      : undefined;

  if (!fallback && resultType !== binaryen.none) {
    throw new Error("non-void if expressions require an else branch");
  }

  if (!fallback) {
    fallback = { expr: ctx.mod.nop(), usedReturnCall: false };
  }

  for (let index = expr.branches.length - 1; index >= 0; index -= 1) {
    const branch = expr.branches[index]!;
    const condition = compileExpr({
      exprId: branch.condition,
      ctx,
      fnCtx,
    }).expr;
    const value = compileExpr({
      exprId: branch.value,
      ctx,
      fnCtx,
      tailPosition,
      expectedResultTypeId,
    });
    fallback = {
      expr: ctx.mod.if(condition, value.expr, fallback.expr),
      usedReturnCall: value.usedReturnCall && fallback.usedReturnCall,
    };
  }

  return fallback;
};

export const compileMatchExpr = (
  expr: HirMatchExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  tailPosition: boolean,
  expectedResultTypeId?: TypeId
): CompiledExpression => {
  const discriminantTypeId = getRequiredExprType(
    expr.discriminant,
    ctx,
    fnCtx.instanceKey
  );
  const discriminantType = getExprBinaryenType(
    expr.discriminant,
    ctx,
    fnCtx.instanceKey
  );
  const discriminantTemp = allocateTempLocal(discriminantType, fnCtx);
  const discriminantValue = compileExpr({
    exprId: expr.discriminant,
    ctx,
    fnCtx,
  }).expr;

  const initDiscriminant = ctx.mod.local.set(
    discriminantTemp.index,
    discriminantValue
  );

  let chain: CompiledExpression | undefined;
  for (let index = expr.arms.length - 1; index >= 0; index -= 1) {
    const arm = expr.arms[index]!;
    const armValue = compileExpr({
      exprId: arm.value,
      ctx,
      fnCtx,
      tailPosition,
      expectedResultTypeId,
    });

    if (arm.pattern.kind === "wildcard") {
      chain = armValue;
      continue;
    }

    if (arm.pattern.kind !== "type") {
      throw new Error(`unsupported match pattern ${arm.pattern.kind}`);
    }

    const condition = compileMatchCondition(
      arm.pattern,
      discriminantTemp,
      discriminantTypeId,
      ctx
    );
    const fallback =
      chain ??
      ({
        expr: ctx.mod.unreachable(),
        usedReturnCall: false,
      } as CompiledExpression);

    chain = {
      expr: ctx.mod.if(condition, armValue.expr, fallback.expr),
      usedReturnCall: armValue.usedReturnCall && fallback.usedReturnCall,
    };
  }

  const finalExpr = chain ?? {
    expr: ctx.mod.unreachable(),
    usedReturnCall: false,
  };

  return {
    expr: ctx.mod.block(
      null,
      [initDiscriminant, finalExpr.expr],
      getExprBinaryenType(expr.id, ctx, fnCtx.instanceKey)
    ),
    usedReturnCall: finalExpr.usedReturnCall,
  };
};

const compileMatchCondition = (
  pattern: HirPattern & { kind: "type" },
  discriminant: LocalBinding,
  discriminantTypeId: TypeId,
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  const patternTypeId = resolvePatternTypeForMatch(
    pattern.type,
    discriminantTypeId,
    ctx
  );
  const structInfo = getStructuralTypeInfo(patternTypeId, ctx);
  if (!structInfo) {
    throw new Error("match pattern requires a structural type");
  }

  const pointer = ctx.mod.local.get(discriminant.index, discriminant.type);
  const ancestors = structGetFieldValue({
    mod: ctx.mod,
    fieldType: ctx.rtt.extensionHelpers.i32Array,
    fieldIndex: RTT_METADATA_SLOTS.ANCESTORS,
    exprRef: pointer,
  });

  return ctx.mod.call(
    "__extends",
    [ctx.mod.i32.const(structInfo.typeId), ancestors],
    binaryen.i32
  );
};

export const compileWhileExpr = (
  expr: HirWhileExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): CompiledExpression => {
  const loopLabel = `while_loop_${expr.id}`;
  const breakLabel = `${loopLabel}_break`;

  const conditionCheck = ctx.mod.if(
    ctx.mod.i32.eqz(
      compileExpr({ exprId: expr.condition, ctx, fnCtx }).expr
    ),
    ctx.mod.br(breakLabel)
  );

  const body = compileExpr({ exprId: expr.body, ctx, fnCtx }).expr;
  const loopBody = ctx.mod.block(null, [
    conditionCheck,
    body,
    ctx.mod.br(loopLabel),
  ]);

  return {
    expr: ctx.mod.block(
      breakLabel,
      [ctx.mod.loop(loopLabel, loopBody)],
      binaryen.none
    ),
    usedReturnCall: false,
  };
};
