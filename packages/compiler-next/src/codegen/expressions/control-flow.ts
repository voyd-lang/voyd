import binaryen from "binaryen";
import { structGetFieldValue } from "@voyd/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirIfExpr,
  HirMatchExpr,
  HirPattern,
  HirWhileExpr,
  LocalBindingLocal,
  TypeId,
} from "../context.js";
import { allocateTempLocal } from "../locals.js";
import { RTT_METADATA_SLOTS } from "../rtt/index.js";
import {
  getExprBinaryenType,
  getRequiredExprType,
  getStructuralTypeInfo,
  getMatchPatternTypeId,
} from "../types.js";
import { exprContainsTarget } from "./contains.js";

const getNominalComponentFromTypingResult = (
  type: TypeId,
  ctx: CodegenContext["typing"]
): TypeId | undefined => {
  const desc = ctx.arena.get(type);
  if (desc.kind === "nominal-object") {
    return type;
  }
  if (desc.kind === "intersection") {
    if (typeof desc.nominal === "number") {
      return desc.nominal;
    }
    if (typeof desc.structural === "number") {
      return getNominalComponentFromTypingResult(desc.structural, ctx);
    }
  }
  return undefined;
};

export const compileIfExpr = (
  expr: HirIfExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  tailPosition: boolean,
  expectedResultTypeId?: TypeId
): CompiledExpression => {
  const resumeTarget = fnCtx.resumeFromSite?.exprId;
  if (typeof resumeTarget === "number") {
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
    const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
    const resultType = getExprBinaryenType(expr.id, ctx, typeInstanceKey);
    const compiledBranches = expr.branches.map((branch) => ({
      condition: compileExpr({
        exprId: branch.condition,
        ctx,
        fnCtx,
      }).expr,
      value: compileExpr({
        exprId: branch.value,
        ctx,
        fnCtx,
        tailPosition,
        expectedResultTypeId,
      }),
    }));
    const defaultBranch =
      typeof expr.defaultBranch === "number"
        ? compileExpr({
            exprId: expr.defaultBranch,
            ctx,
            fnCtx,
            tailPosition,
            expectedResultTypeId,
          })
        : { expr: ctx.mod.nop(), usedReturnCall: false };
    if (
      typeof expr.defaultBranch !== "number" &&
      resultType !== binaryen.none
    ) {
      throw new Error("non-void if expressions require an else branch");
    }

    let chain = defaultBranch;
    for (let index = compiledBranches.length - 1; index >= 0; index -= 1) {
      const branch = compiledBranches[index]!;
      chain = {
        expr: ctx.mod.if(branch.condition, branch.value.expr, chain.expr),
        usedReturnCall:
          branch.value.usedReturnCall && chain.usedReturnCall,
      };
    }

    return chain;
  }

  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  const resultType = getExprBinaryenType(expr.id, ctx, typeInstanceKey);
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
  const resumeTarget = fnCtx.resumeFromSite?.exprId;
  if (typeof resumeTarget === "number") {
    const armWithTarget = expr.arms.find((arm) =>
      exprContainsTarget(arm.value, resumeTarget, ctx)
    );
    if (armWithTarget) {
      const armValue = compileExpr({
        exprId: armWithTarget.value,
        ctx,
        fnCtx,
        tailPosition,
        expectedResultTypeId,
      });
      return armValue;
    }
  }

  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  const discriminantTypeId = getRequiredExprType(
    expr.discriminant,
    ctx,
    typeInstanceKey
  );
  const discriminantType = getExprBinaryenType(
    expr.discriminant,
    ctx,
    typeInstanceKey
  );
  const discriminantTemp = allocateTempLocal(discriminantType, fnCtx);
  const discriminantValue = compileExpr({
    exprId: expr.discriminant,
    ctx,
    fnCtx,
  }).expr;

  const duplicateNominals = (() => {
    const seen = new Set<TypeId>();
    const dupes = new Set<TypeId>();
    expr.arms.forEach((arm) => {
      if (arm.pattern.kind !== "type") {
        return;
      }
      const typeId = getMatchPatternTypeId(arm.pattern, ctx);
      if (typeof typeId !== "number") {
        return;
      }
      const nominals = new Set<TypeId>();
      collectNominalComponents(typeId, ctx, nominals);
      nominals.forEach((nominal) => {
        if (seen.has(nominal)) {
          dupes.add(nominal);
        } else {
          seen.add(nominal);
        }
      });
    });
    return dupes;
  })();

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
      ctx,
      duplicateNominals
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
      getExprBinaryenType(expr.id, ctx, typeInstanceKey)
    ),
    usedReturnCall: finalExpr.usedReturnCall,
  };
};

const compileMatchCondition = (
  pattern: HirPattern & { kind: "type" },
  discriminant: LocalBindingLocal,
  ctx: CodegenContext,
  duplicateNominals: ReadonlySet<TypeId>
): binaryen.ExpressionRef => {
  const patternTypeId = getMatchPatternTypeId(pattern, ctx);
  const patternNominals = new Set<TypeId>();
  collectNominalComponents(patternTypeId, ctx, patternNominals);
  const useStrict = Array.from(patternNominals).some((nominal) =>
    duplicateNominals.has(nominal)
  );
  const makeAncestors = () =>
    structGetFieldValue({
      mod: ctx.mod,
      fieldType: ctx.rtt.extensionHelpers.i32Array,
      fieldIndex: RTT_METADATA_SLOTS.ANCESTORS,
      exprRef: ctx.mod.local.get(discriminant.index, discriminant.type),
    });

  const compileTypeTest = (typeId: TypeId): binaryen.ExpressionRef => {
    const structInfo = getStructuralTypeInfo(typeId, ctx);
    if (!structInfo) {
      throw new Error("match pattern requires a structural type");
    }

    return ctx.mod.call(
      useStrict ? "__has_type" : "__extends",
      [ctx.mod.i32.const(structInfo.typeId), makeAncestors()],
      binaryen.i32
    );
  };

  const collectTargets = (
    typeId: TypeId,
    seen: Set<TypeId>,
    targets: TypeId[]
  ): void => {
    if (seen.has(typeId)) {
      return;
    }
    seen.add(typeId);
    const desc = ctx.typing.arena.get(typeId);
    if (desc.kind === "union") {
      desc.members.forEach((member) => collectTargets(member, seen, targets));
      return;
    }
    targets.push(typeId);
  };

  const targets: TypeId[] = [];
  collectTargets(patternTypeId, new Set<TypeId>(), targets);
  if (targets.length === 0) {
    throw new Error("match pattern requires a structural type");
  }

  return targets.slice(1).reduce(
    (condition, typeId) =>
      ctx.mod.i32.or(condition, compileTypeTest(typeId)),
    compileTypeTest(targets[0]!)
  );
};

export const compileWhileExpr = (
  expr: HirWhileExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): CompiledExpression => {
  const resumeTarget = fnCtx.resumeFromSite?.exprId;
  const bodyContainsTarget =
    typeof resumeTarget === "number" &&
    exprContainsTarget(expr.body, resumeTarget, ctx);
  const conditionContainsTarget =
    typeof resumeTarget === "number" &&
    exprContainsTarget(expr.condition, resumeTarget, ctx);
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

  const body = compileExpr({ exprId: expr.body, ctx, fnCtx }).expr;
  const loopBody = ctx.mod.block(
    null,
    [
      conditionCheck,
      skipFlag
        ? ctx.mod.local.set(skipFlag.index, ctx.mod.i32.const(0))
        : ctx.mod.nop(),
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
      [
        ...(initSkipFlag ? [initSkipFlag] : []),
        ctx.mod.loop(loopLabel, loopBody),
      ],
      binaryen.none
    ),
    usedReturnCall: false,
  };
};
const collectNominalComponents = (
  typeId: TypeId,
  ctx: CodegenContext,
  acc: Set<TypeId>
): void => {
  const nominal = getNominalComponentFromTypingResult(typeId, ctx.typing);
  if (typeof nominal === "number") {
    acc.add(nominal);
    return;
  }
  const desc = ctx.typing.arena.get(typeId);
  if (desc.kind === "union") {
    desc.members.forEach((member) =>
      collectNominalComponents(member, ctx, acc)
    );
  }
};
