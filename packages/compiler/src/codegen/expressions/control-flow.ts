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
import { resolveLoopScope, withLoopScope } from "../control-flow-stack.js";
import { allocateTempLocal, declareLocal } from "../locals.js";
import { RTT_METADATA_SLOTS } from "../rtt/index.js";
import {
  getExprBinaryenType,
  getRequiredExprType,
  getStructuralTypeInfo,
  getMatchPatternTypeId,
} from "../types.js";
import { compilePatternInitializationFromValue } from "../patterns.js";
import type {
  HirBreakExpr,
  HirContinueExpr,
  HirLoopExpr,
} from "../../semantics/hir/index.js";

const declarePatternLocals = (
  pattern: HirPattern,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): void => {
  switch (pattern.kind) {
    case "wildcard":
      return;
    case "identifier":
      declareLocal(pattern.symbol, ctx, fnCtx);
      return;
    case "tuple":
      pattern.elements.forEach((entry) =>
        declarePatternLocals(entry, ctx, fnCtx)
      );
      return;
    case "destructure":
      pattern.fields.forEach((field) =>
        declarePatternLocals(field.pattern, ctx, fnCtx)
      );
      if (pattern.spread) {
        declarePatternLocals(pattern.spread, ctx, fnCtx);
      }
      return;
    case "type":
      if (pattern.binding) {
        declarePatternLocals(pattern.binding, ctx, fnCtx);
      }
      return;
    default: {
      const unknownPattern = pattern as { kind: string };
      throw new Error(`unsupported pattern kind ${unknownPattern.kind}`);
    }
  }
};

const getNominalComponent = (type: TypeId, ctx: CodegenContext): TypeId | undefined => {
  const desc = ctx.program.arena.get(type);
  if (desc.kind === "nominal-object") {
    return type;
  }
  if (desc.kind === "intersection") {
    if (typeof desc.nominal === "number") {
      return desc.nominal;
    }
    if (typeof desc.structural === "number") {
      return getNominalComponent(desc.structural, ctx);
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

  const patternTypeIdFor = (pattern: HirPattern): TypeId | undefined => {
    if (pattern.kind === "wildcard") return undefined;
    if (pattern.kind === "type") {
      return getMatchPatternTypeId(pattern, ctx);
    }
    if (typeof pattern.typeId === "number") {
      return pattern.typeId;
    }
    return undefined;
  };

  const duplicateNominals = (() => {
    const seen = new Set<TypeId>();
    const dupes = new Set<TypeId>();
    expr.arms.forEach((arm) => {
      const typeId = patternTypeIdFor(arm.pattern);
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
    if (arm.pattern.kind === "type" && arm.pattern.binding) {
      declarePatternLocals(arm.pattern.binding, ctx, fnCtx);
    } else if (arm.pattern.kind !== "wildcard") {
      declarePatternLocals(arm.pattern, ctx, fnCtx);
    }

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

    const patternTypeId = patternTypeIdFor(arm.pattern);
    if (typeof patternTypeId !== "number") {
      throw new Error(`match pattern missing type annotation (${arm.pattern.kind})`);
    }

    const condition = compileMatchCondition(
      patternTypeId,
      discriminantTemp,
      ctx,
      duplicateNominals
    );

    const bindingOps: binaryen.ExpressionRef[] = [];
    if (arm.pattern.kind === "type" && arm.pattern.binding) {
      compilePatternInitializationFromValue({
        pattern: arm.pattern.binding,
        value: ctx.mod.local.get(discriminantTemp.index, discriminantTemp.type),
        valueTypeId: patternTypeId,
        ctx,
        fnCtx,
        ops: bindingOps,
        options: { declare: true },
      });
    } else if (arm.pattern.kind !== "type") {
      compilePatternInitializationFromValue({
        pattern: arm.pattern,
        value: ctx.mod.local.get(discriminantTemp.index, discriminantTemp.type),
        valueTypeId: patternTypeId,
        ctx,
        fnCtx,
        ops: bindingOps,
        options: { declare: true },
      });
    }

    const armExpr =
      bindingOps.length === 0
        ? armValue
        : {
            expr: ctx.mod.block(
              null,
              [...bindingOps, armValue.expr],
              binaryen.getExpressionType(armValue.expr)
            ),
            usedReturnCall: armValue.usedReturnCall,
          };

    const fallback =
      chain ??
      ({
        expr: ctx.mod.unreachable(),
        usedReturnCall: false,
      } as CompiledExpression);

    chain = {
      expr: ctx.mod.if(condition, armExpr.expr, fallback.expr),
      usedReturnCall: armExpr.usedReturnCall && fallback.usedReturnCall,
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
  patternTypeId: TypeId,
  discriminant: LocalBindingLocal,
  ctx: CodegenContext,
  duplicateNominals: ReadonlySet<TypeId>
): binaryen.ExpressionRef => {
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
      [ctx.mod.i32.const(structInfo.runtimeTypeId), makeAncestors()],
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
    const desc = ctx.program.arena.get(typeId);
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
  const loopLabel = `while_loop_${expr.id}`;
  const breakLabel = `${loopLabel}_break`;

  const conditionExpr = compileExpr({
    exprId: expr.condition,
    ctx,
    fnCtx,
  }).expr;

  const conditionCheck = ctx.mod.if(
    ctx.mod.i32.eqz(conditionExpr),
    ctx.mod.br(breakLabel)
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
      body,
      ctx.mod.br(loopLabel),
    ],
    binaryen.none
  );

  return {
    expr: ctx.mod.block(
      breakLabel,
      [
        ctx.mod.loop(loopLabel, loopBody),
      ],
      binaryen.none
    ),
    usedReturnCall: false,
  };
};

export const compileLoopExpr = (
  expr: HirLoopExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): CompiledExpression => {
  const loopLabel = `loop_${expr.id}`;
  const breakLabel = `${loopLabel}_break`;
  const body = withLoopScope(
    fnCtx,
    { breakLabel, continueLabel: loopLabel },
    () => compileExpr({ exprId: expr.body, ctx, fnCtx }).expr
  );
  const loopBody = ctx.mod.block(null, [body, ctx.mod.br(loopLabel)], binaryen.none);
  return {
    expr: ctx.mod.block(breakLabel, [ctx.mod.loop(loopLabel, loopBody)], binaryen.none),
    usedReturnCall: false,
  };
};

export const compileBreakExpr = (
  expr: HirBreakExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): CompiledExpression => {
  const target = resolveLoopScope({ fnCtx, label: expr.label });
  const ops: binaryen.ExpressionRef[] = [];

  if (typeof expr.value === "number") {
    const valueExpr = compileExpr({ exprId: expr.value, ctx, fnCtx }).expr;
    ops.push(
      binaryen.getExpressionType(valueExpr) === binaryen.none
        ? valueExpr
        : ctx.mod.drop(valueExpr)
    );
  }
  ops.push(ctx.mod.br(target.breakLabel));

  return {
    expr: ctx.mod.block(null, ops, binaryen.none),
    usedReturnCall: false,
  };
};

export const compileContinueExpr = (
  expr: HirContinueExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): CompiledExpression => {
  const target = resolveLoopScope({ fnCtx, label: expr.label });
  return { expr: ctx.mod.br(target.continueLabel), usedReturnCall: false };
};
const collectNominalComponents = (
  typeId: TypeId,
  ctx: CodegenContext,
  acc: Set<TypeId>
): void => {
  const nominal = getNominalComponent(typeId, ctx);
  if (typeof nominal === "number") {
    acc.add(nominal);
    return;
  }
  const desc = ctx.program.arena.get(typeId);
  if (desc.kind === "union") {
    desc.members.forEach((member) =>
      collectNominalComponents(member, ctx, acc)
    );
  }
};
