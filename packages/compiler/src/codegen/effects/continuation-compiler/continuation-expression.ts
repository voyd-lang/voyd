import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirBlockExpr,
  HirCallExpr,
  HirExprId,
  HirIfExpr,
  HirMatchExpr,
  HirWhileExpr,
  LocalBindingLocal,
  TypeId,
} from "../../context.js";
import { allocateTempLocal } from "../../locals.js";
import { getExprBinaryenType, getRequiredExprType, wasmTypeFor } from "../../types.js";
import { compileCallExpr } from "../../expressions/calls.js";
import { compileBlockExpr, compileStatement } from "../../expressions/blocks.js";
import {
  compileBreakExpr,
  compileContinueExpr,
  compileIfExpr,
  compileLoopExpr,
  compileMatchExpr,
  compileWhileExpr,
} from "../../expressions/control-flow.js";
import { compileAssignExpr } from "../../expressions/mutations.js";
import {
  compileFieldAccessExpr,
  compileObjectLiteralExpr,
  compileTupleExpr,
} from "../../expressions/objects.js";
import { compileLambdaExpr } from "../../expressions/lambdas.js";
import {
  compileIdentifierExpr,
  compileLiteralExpr,
} from "../../expressions/primitives.js";
import { withLoopScope } from "../../control-flow-stack.js";
import {
  exprContainsTarget,
  stmtContainsTarget,
} from "../../expressions/contains.js";
import { unboxOutcomeValue } from "../outcome-values.js";

const compileContinuationBlockExpr = ({
  expr,
  ctx,
  fnCtx,
  compileExpr,
  resumeTarget,
  tailPosition,
  expectedResultTypeId,
}: {
  expr: HirBlockExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  resumeTarget?: HirExprId;
  tailPosition: boolean;
  expectedResultTypeId?: TypeId;
}): CompiledExpression => {
  if (!resumeTarget) {
    return compileBlockExpr(expr, ctx, fnCtx, compileExpr, tailPosition, expectedResultTypeId);
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const statements: binaryen.ExpressionRef[] = [];
  let foundResume = false;

  expr.statements.forEach((stmtId) => {
    if (foundResume) {
      statements.push(compileStatement(stmtId, ctx, fnCtx, compileExpr));
      return;
    }
    if (!stmtContainsTarget(stmtId, resumeTarget, ctx)) {
      return;
    }
    foundResume = true;
    statements.push(compileStatement(stmtId, ctx, fnCtx, compileExpr));
  });

  if (typeof expr.value !== "number") {
    if (statements.length === 0) {
      return { expr: ctx.mod.nop(), usedReturnCall: false };
    }
    return { expr: ctx.mod.block(null, statements, binaryen.none), usedReturnCall: false };
  }

  if (!foundResume && !exprContainsTarget(expr.value, resumeTarget, ctx)) {
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
    expr: ctx.mod.block(null, statements, getExprBinaryenType(expr.id, ctx, typeInstanceId)),
    usedReturnCall,
  };
};

const compileContinuationIfExpr = ({
  expr,
  ctx,
  fnCtx,
  compileExpr,
  resumeTarget,
  tailPosition,
  expectedResultTypeId,
}: {
  expr: HirIfExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  resumeTarget?: HirExprId;
  tailPosition: boolean;
  expectedResultTypeId?: TypeId;
}): CompiledExpression => {
  if (!resumeTarget) {
    return compileIfExpr(expr, ctx, fnCtx, compileExpr, tailPosition, expectedResultTypeId);
  }

  const branchWithTarget = expr.branches.find(
    (branch) =>
      exprContainsTarget(branch.value, resumeTarget, ctx) &&
      !exprContainsTarget(branch.condition, resumeTarget, ctx)
  );
  if (branchWithTarget) {
    return compileExpr({
      exprId: branchWithTarget.value,
      ctx,
      fnCtx,
      tailPosition,
      expectedResultTypeId,
    });
  }

  if (
    typeof expr.defaultBranch === "number" &&
    exprContainsTarget(expr.defaultBranch, resumeTarget, ctx)
  ) {
    return compileExpr({
      exprId: expr.defaultBranch,
      ctx,
      fnCtx,
      tailPosition,
      expectedResultTypeId,
    });
  }

  return compileIfExpr(expr, ctx, fnCtx, compileExpr, tailPosition, expectedResultTypeId);
};

const compileContinuationMatchExpr = ({
  expr,
  ctx,
  fnCtx,
  compileExpr,
  resumeTarget,
  tailPosition,
  expectedResultTypeId,
}: {
  expr: HirMatchExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  resumeTarget?: HirExprId;
  tailPosition: boolean;
  expectedResultTypeId?: TypeId;
}): CompiledExpression => {
  if (!resumeTarget) {
    return compileMatchExpr(expr, ctx, fnCtx, compileExpr, tailPosition, expectedResultTypeId);
  }

  const armWithTarget = expr.arms.find((arm) => exprContainsTarget(arm.value, resumeTarget, ctx));
  if (armWithTarget) {
    return compileExpr({
      exprId: armWithTarget.value,
      ctx,
      fnCtx,
      tailPosition,
      expectedResultTypeId,
    });
  }

  return compileMatchExpr(expr, ctx, fnCtx, compileExpr, tailPosition, expectedResultTypeId);
};

const compileContinuationWhileExpr = ({
  expr,
  ctx,
  fnCtx,
  compileExpr,
  resumeTarget,
}: {
  expr: HirWhileExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  resumeTarget?: HirExprId;
}): CompiledExpression => {
  if (!resumeTarget) {
    return compileWhileExpr(expr, ctx, fnCtx, compileExpr);
  }

  const bodyContainsTarget = exprContainsTarget(expr.body, resumeTarget, ctx);
  const conditionContainsTarget = exprContainsTarget(
    expr.condition,
    resumeTarget,
    ctx
  );
  const loopLabel = `while_loop_${expr.id}`;
  const breakLabel = `${loopLabel}_break`;
  const skipConditionOnce = bodyContainsTarget && !conditionContainsTarget;
  const skipFlag = skipConditionOnce
    ? allocateTempLocal(binaryen.i32, fnCtx)
    : undefined;

  const conditionExpr = compileExpr({
    exprId: expr.condition,
    ctx,
    fnCtx,
  }).expr;

  const conditionCheck = skipFlag
    ? ctx.mod.if(
        ctx.mod.i32.eqz(ctx.mod.local.get(skipFlag.index, binaryen.i32)),
        ctx.mod.if(ctx.mod.i32.eqz(conditionExpr), ctx.mod.br(breakLabel))
      )
    : ctx.mod.if(ctx.mod.i32.eqz(conditionExpr), ctx.mod.br(breakLabel));

  const body = withLoopScope(
    fnCtx,
    { breakLabel, continueLabel: loopLabel },
    () => compileExpr({ exprId: expr.body, ctx, fnCtx }).expr
  );
  const loopBody = ctx.mod.block(
    null,
    [
      conditionCheck,
      skipFlag ? ctx.mod.local.set(skipFlag.index, ctx.mod.i32.const(0)) : ctx.mod.nop(),
      body,
      ctx.mod.br(loopLabel),
    ],
    binaryen.none
  );

  const initSkipFlag = skipFlag
    ? ctx.mod.local.set(skipFlag.index, ctx.mod.i32.const(1))
    : undefined;

  return {
    expr: ctx.mod.block(
      breakLabel,
      [...(initSkipFlag ? [initSkipFlag] : []), ctx.mod.loop(loopLabel, loopBody)],
      binaryen.none
    ),
    usedReturnCall: false,
  };
};

export const createContinuationExpressionCompiler = ({
  targetExprId,
  resumeLocal,
  resumeValueTypeId,
}: {
  targetExprId: HirExprId;
  resumeLocal?: LocalBindingLocal;
  resumeValueTypeId?: TypeId;
}): ExpressionCompiler => {
  let resumeActive = true;

  const compileExpr: ExpressionCompiler = ({
    exprId,
    ctx,
    fnCtx,
    tailPosition = false,
    expectedResultTypeId,
  }): CompiledExpression => {
    if (resumeActive && exprId === targetExprId) {
      resumeActive = false;
      if (!resumeLocal) {
        return { expr: ctx.mod.nop(), usedReturnCall: false };
      }

      const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
      const resolvedTypeId =
        typeof resumeValueTypeId === "number" &&
        ctx.program.types.getTypeDesc(resumeValueTypeId).kind !== "type-param-ref"
          ? resumeValueTypeId
          : getRequiredExprType(exprId, ctx, typeInstanceId);
      const valueType = wasmTypeFor(resolvedTypeId, ctx);
      const payload = ctx.mod.local.get(resumeLocal.index, resumeLocal.type);
      if (valueType !== resumeLocal.type && resumeLocal.type === binaryen.eqref) {
        return {
          expr:
            valueType === binaryen.none
              ? ctx.mod.block(null, [ctx.mod.drop(payload)], binaryen.none)
              : unboxOutcomeValue({ payload, valueType, ctx }),
          usedReturnCall: false,
        };
      }
      return { expr: payload, usedReturnCall: false };
    }

    const expr = ctx.module.hir.expressions.get(exprId);
    if (!expr) {
      throw new Error(`codegen missing HirExpression ${exprId}`);
    }

    const resumeTarget =
      resumeActive && exprContainsTarget(exprId, targetExprId, ctx) ? targetExprId : undefined;
    const exprKind = expr.exprKind;

    switch (exprKind) {
      case "literal":
        return compileLiteralExpr(expr, ctx);
      case "identifier":
        return compileIdentifierExpr(expr, ctx, fnCtx);
      case "overload-set":
        throw new Error("overload sets cannot be evaluated directly");
      case "call":
        return compileCallExpr(expr as HirCallExpr, ctx, fnCtx, compileExpr, {
          tailPosition,
          expectedResultTypeId,
        });
      case "block":
        return compileContinuationBlockExpr({
          expr,
          ctx,
          fnCtx,
          compileExpr,
          resumeTarget,
          tailPosition,
          expectedResultTypeId,
        });
      case "cond":
      case "if":
        return compileContinuationIfExpr({
          expr: expr as HirIfExpr,
          ctx,
          fnCtx,
          compileExpr,
          resumeTarget,
          tailPosition,
          expectedResultTypeId,
        });
      case "match":
        return compileContinuationMatchExpr({
          expr,
          ctx,
          fnCtx,
          compileExpr,
          resumeTarget,
          tailPosition,
          expectedResultTypeId,
        });
      case "while":
        return compileContinuationWhileExpr({
          expr,
          ctx,
          fnCtx,
          compileExpr,
          resumeTarget,
        });
      case "loop":
        return compileLoopExpr(expr, ctx, fnCtx, compileExpr);
      case "assign":
        return compileAssignExpr(expr, ctx, fnCtx, compileExpr);
      case "break":
        return compileBreakExpr(expr, ctx, fnCtx, compileExpr);
      case "continue":
        return compileContinueExpr(expr, ctx, fnCtx);
      case "object-literal":
        return compileObjectLiteralExpr(expr, ctx, fnCtx, compileExpr);
      case "field-access":
        return compileFieldAccessExpr(expr, ctx, fnCtx, compileExpr);
      case "tuple":
        return compileTupleExpr(expr, ctx, fnCtx, compileExpr);
      case "lambda":
        return compileLambdaExpr(expr, ctx, fnCtx, compileExpr);
      case "effect-handler":
        return ctx.effectsBackend.compileEffectHandlerExpr({
          expr,
          ctx,
          fnCtx,
          compileExpr,
          tailPosition,
          expectedResultTypeId,
        });
      default:
        throw new Error(`codegen does not support ${exprKind} expressions yet`);
    }
  };

  return compileExpr;
};
