import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirBlockExpr,
  HirCallExpr,
  HirMethodCallExpr,
  HirCondExpr,
  HirExprId,
  HirIfExpr,
  HirMatchExpr,
  HirWhileExpr,
  LocalBindingLocal,
  TypeId,
} from "../../context.js";
import { allocateTempLocal } from "../../locals.js";
import { getExprBinaryenType, getRequiredExprType, wasmTypeFor } from "../../types.js";
import { compileCallExpr, compileMethodCallExpr } from "../../expressions/calls.js";
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
import type { GroupContinuationCfg } from "../continuation-cfg.js";
import { unboxOutcomeValue } from "../outcome-values.js";

const hasGroupSites = (exprId: HirExprId, cfg: GroupContinuationCfg): boolean =>
  (cfg.sitesByExpr.get(exprId)?.size ?? 0) > 0;

const activeSiteInSet = ({
  sites,
  activeSiteOrder,
  ctx,
}: {
  sites: ReadonlySet<number>;
  activeSiteOrder: () => binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (sites.size === 0) return ctx.mod.i32.const(0);
  const comparisons = [...sites].map((siteOrder) =>
    ctx.mod.i32.eq(activeSiteOrder(), ctx.mod.i32.const(siteOrder))
  );
  return comparisons.reduce(
    (acc, cmp) => ctx.mod.i32.or(acc, cmp),
    ctx.mod.i32.const(0)
  );
};

const compileGroupedContinuationBlockExpr = ({
  expr,
  ctx,
  fnCtx,
  compileExpr,
  cfg,
  activeSiteOrder,
  startedLocal,
  tailPosition,
  expectedResultTypeId,
}: {
  expr: HirBlockExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  cfg: GroupContinuationCfg;
  activeSiteOrder: () => binaryen.ExpressionRef;
  startedLocal: LocalBindingLocal;
  tailPosition: boolean;
  expectedResultTypeId?: TypeId;
}): CompiledExpression => {
  if (!hasGroupSites(expr.id, cfg)) {
    return compileBlockExpr(
      expr,
      ctx,
      fnCtx,
      compileExpr,
      tailPosition,
      expectedResultTypeId
    );
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const started = () => ctx.mod.local.get(startedLocal.index, startedLocal.type);
  const statements: binaryen.ExpressionRef[] = [];

  expr.statements.forEach((stmtId) => {
    const sites = cfg.sitesByStmt.get(stmtId) ?? new Set<number>();
    const shouldRun =
      sites.size === 0
        ? started()
        : ctx.mod.i32.or(started(), activeSiteInSet({ sites, activeSiteOrder, ctx }));
    statements.push(
      ctx.mod.if(
        shouldRun,
        compileStatement(stmtId, ctx, fnCtx, compileExpr),
        ctx.mod.nop()
      )
    );
  });

  if (typeof expr.value !== "number") {
    if (statements.length === 0) {
      return { expr: ctx.mod.nop(), usedReturnCall: false };
    }
    return {
      expr: ctx.mod.block(null, statements, binaryen.none),
      usedReturnCall: false,
    };
  }

  const value = compileExpr({
    exprId: expr.value,
    ctx,
    fnCtx,
    tailPosition,
    expectedResultTypeId,
  });

  if (statements.length === 0) {
    return value;
  }

  statements.push(value.expr);
  return {
    expr: ctx.mod.block(
      null,
      statements,
      getExprBinaryenType(expr.id, ctx, typeInstanceId)
    ),
    usedReturnCall: value.usedReturnCall,
  };
};

const compileGroupedContinuationIfExpr = ({
  expr,
  ctx,
  fnCtx,
  compileExpr,
  cfg,
  activeSiteOrder,
  startedLocal,
  tailPosition,
  expectedResultTypeId,
}: {
  expr: HirIfExpr | HirCondExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  cfg: GroupContinuationCfg;
  activeSiteOrder: () => binaryen.ExpressionRef;
  startedLocal: LocalBindingLocal;
  tailPosition: boolean;
  expectedResultTypeId?: TypeId;
}): CompiledExpression => {
  if (!hasGroupSites(expr.id, cfg)) {
    return compileIfExpr(
      expr as HirIfExpr,
      ctx,
      fnCtx,
      compileExpr,
      tailPosition,
      expectedResultTypeId
    );
  }

  const started = () => ctx.mod.local.get(startedLocal.index, startedLocal.type);
  const beforeActive = () => ctx.mod.i32.eqz(started());

  let fallback = compileIfExpr(
    expr as HirIfExpr,
    ctx,
    fnCtx,
    compileExpr,
    tailPosition,
    expectedResultTypeId
  );

  if (typeof expr.defaultBranch === "number") {
    const defaultSites = cfg.sitesByExpr.get(expr.defaultBranch) ?? new Set<number>();
    if (defaultSites.size > 0) {
      const activeInDefault = activeSiteInSet({
        sites: defaultSites,
        activeSiteOrder,
        ctx,
      });
      const defaultExpr = compileExpr({
        exprId: expr.defaultBranch,
        ctx,
        fnCtx,
        tailPosition,
        expectedResultTypeId,
      });
      const cond = ctx.mod.i32.and(beforeActive(), activeInDefault);
      fallback = {
        expr: ctx.mod.if(cond, defaultExpr.expr, fallback.expr),
        usedReturnCall: defaultExpr.usedReturnCall && fallback.usedReturnCall,
      };
    }
  }

  for (let index = expr.branches.length - 1; index >= 0; index -= 1) {
    const branch = expr.branches[index]!;
    const valueSites = cfg.sitesByExpr.get(branch.value) ?? new Set<number>();
    if (valueSites.size === 0) continue;
    const conditionSites =
      cfg.sitesByExpr.get(branch.condition) ?? new Set<number>();
    const activeInValue = activeSiteInSet({
      sites: valueSites,
      activeSiteOrder,
      ctx,
    });
    const activeInCondition = activeSiteInSet({
      sites: conditionSites,
      activeSiteOrder,
      ctx,
    });
    const branchExpr = compileExpr({
      exprId: branch.value,
      ctx,
      fnCtx,
      tailPosition,
      expectedResultTypeId,
    });
    const cond = ctx.mod.i32.and(
      beforeActive(),
      ctx.mod.i32.and(activeInValue, ctx.mod.i32.eqz(activeInCondition))
    );
    fallback = {
      expr: ctx.mod.if(cond, branchExpr.expr, fallback.expr),
      usedReturnCall: branchExpr.usedReturnCall && fallback.usedReturnCall,
    };
  }

  return fallback;
};

const compileGroupedContinuationMatchExpr = ({
  expr,
  ctx,
  fnCtx,
  compileExpr,
  cfg,
  activeSiteOrder,
  startedLocal,
  tailPosition,
  expectedResultTypeId,
}: {
  expr: HirMatchExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  cfg: GroupContinuationCfg;
  activeSiteOrder: () => binaryen.ExpressionRef;
  startedLocal: LocalBindingLocal;
  tailPosition: boolean;
  expectedResultTypeId?: TypeId;
}): CompiledExpression => {
  if (!hasGroupSites(expr.id, cfg)) {
    return compileMatchExpr(
      expr,
      ctx,
      fnCtx,
      compileExpr,
      tailPosition,
      expectedResultTypeId
    );
  }

  const started = () => ctx.mod.local.get(startedLocal.index, startedLocal.type);
  const beforeActive = () => ctx.mod.i32.eqz(started());

  let fallback = compileMatchExpr(
    expr,
    ctx,
    fnCtx,
    compileExpr,
    tailPosition,
    expectedResultTypeId
  );

  const discriminantSites =
    cfg.sitesByExpr.get(expr.discriminant) ?? new Set<number>();
  const activeInDiscriminant = activeSiteInSet({
    sites: discriminantSites,
    activeSiteOrder,
    ctx,
  });

  for (let index = expr.arms.length - 1; index >= 0; index -= 1) {
    const arm = expr.arms[index]!;
    const valueSites = cfg.sitesByExpr.get(arm.value) ?? new Set<number>();
    if (valueSites.size === 0) continue;
    const guardSites =
      typeof arm.guard === "number"
        ? cfg.sitesByExpr.get(arm.guard) ?? new Set<number>()
        : new Set<number>();
    const activeInValue = activeSiteInSet({
      sites: valueSites,
      activeSiteOrder,
      ctx,
    });
    const activeInGuard = activeSiteInSet({
      sites: guardSites,
      activeSiteOrder,
      ctx,
    });
    const armExpr = compileExpr({
      exprId: arm.value,
      ctx,
      fnCtx,
      tailPosition,
      expectedResultTypeId,
    });
    const cond = ctx.mod.i32.and(
      beforeActive(),
      ctx.mod.i32.and(
        activeInValue,
        ctx.mod.i32.and(
          ctx.mod.i32.eqz(activeInGuard),
          ctx.mod.i32.eqz(activeInDiscriminant)
        )
      )
    );
    fallback = {
      expr: ctx.mod.if(cond, armExpr.expr, fallback.expr),
      usedReturnCall: armExpr.usedReturnCall && fallback.usedReturnCall,
    };
  }

  return fallback;
};

const compileGroupedContinuationWhileExpr = ({
  expr,
  ctx,
  fnCtx,
  compileExpr,
  cfg,
  activeSiteOrder,
  startedLocal,
}: {
  expr: HirWhileExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  cfg: GroupContinuationCfg;
  activeSiteOrder: () => binaryen.ExpressionRef;
  startedLocal: LocalBindingLocal;
}): CompiledExpression => {
  if (!hasGroupSites(expr.id, cfg)) {
    return compileWhileExpr(expr, ctx, fnCtx, compileExpr);
  }

  const bodySites = cfg.sitesByExpr.get(expr.body) ?? new Set<number>();
  const conditionSites =
    cfg.sitesByExpr.get(expr.condition) ?? new Set<number>();
  if (bodySites.size === 0) {
    return compileWhileExpr(expr, ctx, fnCtx, compileExpr);
  }

  const started = () => ctx.mod.local.get(startedLocal.index, startedLocal.type);
  const beforeActive = () => ctx.mod.i32.eqz(started());
  const skipFlag = allocateTempLocal(binaryen.i32, fnCtx);
  const shouldSkipOnce = ctx.mod.i32.and(
    beforeActive(),
    ctx.mod.i32.and(
      activeSiteInSet({ sites: bodySites, activeSiteOrder, ctx }),
      ctx.mod.i32.eqz(
        activeSiteInSet({ sites: conditionSites, activeSiteOrder, ctx })
      )
    )
  );

  const loopLabel = `while_loop_${expr.id}`;
  const breakLabel = `${loopLabel}_break`;
  const initSkipFlag = ctx.mod.local.set(skipFlag.index, shouldSkipOnce);

  const conditionExpr = compileExpr({
    exprId: expr.condition,
    ctx,
    fnCtx,
  }).expr;

  const conditionCheck = ctx.mod.if(
    ctx.mod.i32.eqz(ctx.mod.local.get(skipFlag.index, binaryen.i32)),
    ctx.mod.if(ctx.mod.i32.eqz(conditionExpr), ctx.mod.br(breakLabel)),
    ctx.mod.nop()
  );

  const body = withLoopScope(
    fnCtx,
    { breakLabel, continueLabel: loopLabel },
    () => compileExpr({ exprId: expr.body, ctx, fnCtx }).expr
  );
  const loopBody = ctx.mod.block(
    null,
    [
      conditionCheck,
      ctx.mod.local.set(skipFlag.index, ctx.mod.i32.const(0)),
      body,
      ctx.mod.br(loopLabel),
    ],
    binaryen.none
  );

  return {
    expr: ctx.mod.block(
      breakLabel,
      [initSkipFlag, ctx.mod.loop(loopLabel, loopBody)],
      binaryen.none
    ),
    usedReturnCall: false,
  };
};

export const createGroupedContinuationExpressionCompiler = ({
  cfg,
  activeSiteOrder,
  startedLocal,
  resumeLocal,
}: {
  cfg: GroupContinuationCfg;
  activeSiteOrder: () => binaryen.ExpressionRef;
  startedLocal: LocalBindingLocal;
  resumeLocal?: LocalBindingLocal;
}): ExpressionCompiler => {
  const compileExpr: ExpressionCompiler = ({
    exprId,
    ctx,
    fnCtx,
    tailPosition = false,
    expectedResultTypeId,
  }): CompiledExpression => {
    const expr = ctx.module.hir.expressions.get(exprId);
    if (!expr) {
      throw new Error(`codegen missing HirExpression ${exprId}`);
    }

    const siteOrder = cfg.siteOrderByExpr.get(exprId);
    if (typeof siteOrder === "number") {
      if (expr.exprKind !== "call" && expr.exprKind !== "method-call") {
        throw new Error("continuation targets must be call expressions");
      }
      const site = cfg.siteByExprId.get(exprId);
      if (!site) {
        throw new Error("missing site metadata for continuation target");
      }
      const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
      const resumeTypeId = getRequiredExprType(site.exprId, ctx, typeInstanceId);
      const valueType = wasmTypeFor(resumeTypeId, ctx);
      const started = () => ctx.mod.local.get(startedLocal.index, startedLocal.type);
      const cond = ctx.mod.i32.and(
        ctx.mod.i32.eqz(started()),
        ctx.mod.i32.eq(activeSiteOrder(), ctx.mod.i32.const(siteOrder))
      );
      const normal =
        expr.exprKind === "call"
          ? compileCallExpr(expr as HirCallExpr, ctx, fnCtx, compileExpr, {
              tailPosition,
              expectedResultTypeId,
            })
          : compileMethodCallExpr(
              expr as HirMethodCallExpr,
              ctx,
              fnCtx,
              compileExpr,
              { tailPosition, expectedResultTypeId }
            );
      const resumeSet = ctx.mod.local.set(startedLocal.index, ctx.mod.i32.const(1));
      const resumeBox = resumeLocal
        ? ctx.mod.local.get(resumeLocal.index, resumeLocal.type)
        : ctx.mod.ref.null(binaryen.eqref);
      const resumedValue =
        valueType === binaryen.none
          ? ctx.mod.block(null, [ctx.mod.drop(resumeBox)], binaryen.none)
          : unboxOutcomeValue({ payload: resumeBox, valueType, ctx });
      const resumedExpr = ctx.mod.block(null, [resumeSet, resumedValue], valueType);
      return {
        expr: ctx.mod.if(cond, resumedExpr, normal.expr),
        usedReturnCall: normal.usedReturnCall,
      };
    }

    if (hasGroupSites(exprId, cfg)) {
      switch (expr.exprKind) {
        case "block":
          return compileGroupedContinuationBlockExpr({
            expr,
            ctx,
            fnCtx,
            compileExpr,
            cfg,
            activeSiteOrder,
            startedLocal,
            tailPosition,
            expectedResultTypeId,
          });
        case "cond":
        case "if":
          return compileGroupedContinuationIfExpr({
            expr: expr as HirIfExpr,
            ctx,
            fnCtx,
            compileExpr,
            cfg,
            activeSiteOrder,
            startedLocal,
            tailPosition,
            expectedResultTypeId,
          });
        case "match":
          return compileGroupedContinuationMatchExpr({
            expr,
            ctx,
            fnCtx,
            compileExpr,
            cfg,
            activeSiteOrder,
            startedLocal,
            tailPosition,
            expectedResultTypeId,
          });
        case "while":
          return compileGroupedContinuationWhileExpr({
            expr,
            ctx,
            fnCtx,
            compileExpr,
            cfg,
            activeSiteOrder,
            startedLocal,
          });
        default:
          break;
      }
    }

    const exprKind = expr.exprKind;
    switch (exprKind) {
      case "literal":
        return compileLiteralExpr(expr, ctx);
      case "identifier":
        return compileIdentifierExpr(expr, ctx, fnCtx);
      case "overload-set":
        throw new Error("overload sets cannot be evaluated directly");
      case "call":
        return compileCallExpr(expr, ctx, fnCtx, compileExpr, {
          tailPosition,
          expectedResultTypeId,
        });
      case "method-call":
        return compileMethodCallExpr(expr, ctx, fnCtx, compileExpr, {
          tailPosition,
          expectedResultTypeId,
        });
      case "block":
        return compileBlockExpr(
          expr,
          ctx,
          fnCtx,
          compileExpr,
          tailPosition,
          expectedResultTypeId
        );
      case "cond":
      case "if":
        return compileIfExpr(
          expr as HirIfExpr,
          ctx,
          fnCtx,
          compileExpr,
          tailPosition,
          expectedResultTypeId
        );
      case "match":
        return compileMatchExpr(
          expr,
          ctx,
          fnCtx,
          compileExpr,
          tailPosition,
          expectedResultTypeId
        );
      case "while":
        return compileWhileExpr(expr, ctx, fnCtx, compileExpr);
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
