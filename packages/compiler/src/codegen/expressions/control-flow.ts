import binaryen from "binaryen";
import { refTest, structGetFieldValue } from "@voyd/lib/binaryen-gc/index.js";
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
import {
  allocateLoopLabels,
  resolveLoopScope,
  withLoopScope,
} from "../control-flow-stack.js";
import {
  allocateTempLocal,
  declareLocal,
  loadLocalValue,
  storeLocalValue,
} from "../locals.js";
import { RTT_METADATA_SLOTS } from "../rtt/index.js";
import {
  getInlineUnionLayout,
  getOptionalLayoutInfo,
  getRequiredExprType,
  getStructuralTypeInfo,
  getMatchPatternTypeId,
  getTypeIdFromTypeExpr,
  getUnresolvedExprType,
  shouldInlineUnionLayout,
  wasmTypeFor,
} from "../types.js";
import { compilePatternInitializationFromValue } from "../patterns.js";
import { asStatement, coerceToBinaryenType } from "./utils.js";
import {
  coerceValueToType,
} from "../structural.js";
import { coerceExprToWasmType } from "../wasm-type-coercions.js";
import { captureMultivalueLanes } from "../multivalue.js";
import type {
  HirBreakExpr,
  HirContinueExpr,
  HirLoopExpr,
} from "../../semantics/hir/index.js";

const declarePatternLocals = (
  pattern: HirPattern,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
): void => {
  switch (pattern.kind) {
    case "wildcard":
      return;
    case "identifier":
      declareLocal(pattern.symbol, ctx, fnCtx);
      return;
    case "tuple":
      pattern.elements.forEach((entry) =>
        declarePatternLocals(entry, ctx, fnCtx),
      );
      return;
    case "destructure":
      pattern.fields.forEach((field) =>
        declarePatternLocals(field.pattern, ctx, fnCtx),
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

const getNominalComponent = (
  type: TypeId,
  ctx: CodegenContext,
): TypeId | undefined => {
  const desc = ctx.program.types.getTypeDesc(type);
  if (desc.kind === "nominal-object" || desc.kind === "value-object") {
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

const getValueSourceTypeId = (
  exprId: number,
  ctx: CodegenContext,
  instanceId?: FunctionContext["typeInstanceId"],
): TypeId => {
  let currentExprId = exprId;
  while (true) {
    const expr = ctx.module.hir.expressions.get(currentExprId);
    if (expr?.exprKind === "object-literal") {
      if (expr.literalKind === "nominal" && typeof expr.targetSymbol === "number") {
        const canonicalTarget = ctx.program.symbols.canonicalIdOf(
          ctx.moduleId,
          expr.targetSymbol,
        );
        const template = ctx.program.objects.getTemplate(canonicalTarget);
        if (template) {
          return template.type;
        }
      }
      if (expr.literalKind === "nominal" && expr.target) {
        return getTypeIdFromTypeExpr(expr.target, ctx);
      }
      return getRequiredExprType(currentExprId, ctx, instanceId);
    }
    if (!expr || expr.exprKind !== "block" || typeof expr.value !== "number") {
      return getUnresolvedExprType(currentExprId, ctx, instanceId);
    }
    currentExprId = expr.value;
  }
};

const expressionUsesExpectedResultType = ({
  exprId,
  ctx,
}: {
  exprId: number;
  ctx: CodegenContext;
}): boolean => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr) {
    return false;
  }
  switch (expr.exprKind) {
    case "identifier":
    case "call":
    case "method-call":
    case "block":
    case "if":
    case "match":
    case "effect-handler":
      return true;
    default:
      return false;
  }
};

export const compileIfExpr = (
  expr: HirIfExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  tailPosition: boolean,
  expectedResultTypeId?: TypeId,
): CompiledExpression => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const resultTypeId =
    expectedResultTypeId ?? getRequiredExprType(expr.id, ctx, typeInstanceId);
  const resultType = wasmTypeFor(resultTypeId, ctx);
  const coerceBranchValue = ({
    compiled,
    exprId,
  }: {
    compiled: CompiledExpression;
    exprId: number;
  }): binaryen.ExpressionRef => {
    const actualTypeId = expressionUsesExpectedResultType({
      exprId,
      ctx,
    })
      ? resultTypeId
      : getValueSourceTypeId(exprId, ctx, typeInstanceId);
    return coerceValueToType({
      value: compiled.expr,
      actualType: actualTypeId,
      targetType: resultTypeId,
      ctx,
      fnCtx,
    });
  };
  let fallback =
    typeof expr.defaultBranch === "number"
      ? compileExpr({
          exprId: expr.defaultBranch,
          ctx,
          fnCtx,
          tailPosition,
          expectedResultTypeId: expressionUsesExpectedResultType({
            exprId: expr.defaultBranch,
            ctx,
          })
            ? resultTypeId
            : undefined,
        })
      : undefined;

  if (!fallback && resultType !== binaryen.none) {
    throw new Error("non-void if expressions require an else branch");
  }

  if (!fallback) {
    fallback = { expr: ctx.mod.nop(), usedReturnCall: false };
  } else if (typeof expr.defaultBranch === "number") {
    const coercedFallback = coerceBranchValue({
      compiled: fallback,
      exprId: expr.defaultBranch,
    });
    fallback = {
      expr: coerceToBinaryenType(
        ctx,
        coercedFallback,
        resultType,
        fnCtx,
      ),
      usedReturnCall: fallback.usedReturnCall,
    };
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
      expectedResultTypeId: expressionUsesExpectedResultType({
        exprId: branch.value,
        ctx,
      })
        ? resultTypeId
        : undefined,
    });
    const coercedThen = coerceBranchValue({
      compiled: value,
      exprId: branch.value,
    });
    const typedThen = coerceToBinaryenType(
      ctx,
      coercedThen,
      resultType,
      fnCtx,
    );
    const typedElse: binaryen.ExpressionRef = fallback.expr;
    fallback = {
      expr: ctx.mod.if(condition, typedThen, typedElse),
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
  expectedResultTypeId?: TypeId,
): CompiledExpression => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const resultTypeId =
    expectedResultTypeId ?? getRequiredExprType(expr.id, ctx, typeInstanceId);
  const resultType = wasmTypeFor(resultTypeId, ctx);
  const discriminantTypeId = getRequiredExprType(expr.discriminant, ctx, typeInstanceId);
  const discriminantType = wasmTypeFor(discriminantTypeId, ctx);
  const discriminantTemp = allocateTempLocal(
    discriminantType,
    fnCtx,
    discriminantTypeId,
    ctx,
  );
  const discriminantValue = coerceValueToType({
    value: compileExpr({
      exprId: expr.discriminant,
      ctx,
      fnCtx,
      expectedResultTypeId: discriminantTypeId,
    }).expr,
    actualType: discriminantTypeId,
    targetType: discriminantTypeId,
    ctx,
    fnCtx,
  });
  const inlineDiscriminantLayout = shouldInlineUnionLayout(discriminantTypeId, ctx)
    ? getInlineUnionLayout(discriminantTypeId, ctx)
    : undefined;
  const discriminantLaneTemps =
    inlineDiscriminantLayout && inlineDiscriminantLayout.abiTypes.length > 1
      ? inlineDiscriminantLayout.abiTypes.map((type) =>
          allocateTempLocal(type, fnCtx),
        )
      : undefined;
  const loadStoredDiscriminant = (): binaryen.ExpressionRef => {
    if (discriminantLaneTemps) {
      const lanes = discriminantLaneTemps.map((lane) =>
        loadLocalValue(lane, ctx),
      );
      return lanes.length === 1
        ? lanes[0]!
        : ctx.mod.tuple.make(lanes as binaryen.ExpressionRef[]);
    }
    return loadLocalValue(discriminantTemp, ctx);
  };

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

  const initDiscriminant = discriminantLaneTemps
    ? (() => {
        const captured = captureMultivalueLanes({
          value: coerceExprToWasmType({
            expr: discriminantValue,
            targetType: inlineDiscriminantLayout!.interfaceType,
            ctx,
          }),
          abiTypes: inlineDiscriminantLayout!.abiTypes,
          ctx,
          fnCtx,
        });
        return ctx.mod.block(
          null,
          [
            ...captured.setup,
            ...discriminantLaneTemps.map((lane, index) =>
              storeLocalValue({
                binding: lane,
                value: captured.lanes[index]!,
                ctx,
                fnCtx,
              }),
            ),
          ],
          binaryen.none,
        );
      })()
    : storeLocalValue({
        binding: discriminantTemp,
        value: discriminantValue,
        ctx,
        fnCtx,
      });
  const discriminantExpr = ctx.module.hir.expressions.get(expr.discriminant);
  const discriminantSymbol =
    discriminantExpr?.exprKind === "identifier" ? discriminantExpr.symbol : undefined;

  let chain: CompiledExpression | undefined;
  for (let index = expr.arms.length - 1; index >= 0; index -= 1) {
    const arm = expr.arms[index]!;
    if (arm.pattern.kind === "type" && arm.pattern.binding) {
      declarePatternLocals(arm.pattern.binding, ctx, fnCtx);
    } else if (arm.pattern.kind !== "wildcard") {
      declarePatternLocals(arm.pattern, ctx, fnCtx);
    }

    if (arm.pattern.kind === "wildcard") {
      const armValue = compileExpr({
        exprId: arm.value,
        ctx,
        fnCtx,
        tailPosition,
      });
      const armTypeId = expressionUsesExpectedResultType({
        exprId: arm.value,
        ctx,
      })
        ? resultTypeId
        : getValueSourceTypeId(arm.value, ctx, typeInstanceId);
      chain = {
        expr: coerceToBinaryenType(
          ctx,
          coerceValueToType({
            value: armValue.expr,
            actualType: armTypeId,
            targetType: resultTypeId,
            ctx,
            fnCtx,
          }),
          resultType,
          fnCtx,
        ),
        usedReturnCall: armValue.usedReturnCall,
      };
      continue;
    }

    const patternTypeId = patternTypeIdFor(arm.pattern);
    if (typeof patternTypeId !== "number") {
      throw new Error(
        `match pattern missing type annotation (${arm.pattern.kind})`,
      );
    }

    const condition = compileMatchCondition(
      patternTypeId,
      discriminantTypeId,
      loadStoredDiscriminant,
      discriminantTemp,
      ctx,
      duplicateNominals,
    );

    const discriminantOptionalInfo = shouldInlineUnionLayout(discriminantTypeId, ctx)
      ? getOptionalLayoutInfo(discriminantTypeId, ctx)
      : undefined;
    const optionalSomePayload =
      discriminantOptionalInfo &&
      patternTypeId === discriminantOptionalInfo.someType
        ? (() => {
            const someLayout = getInlineUnionLayout(discriminantTypeId, ctx).members.find(
              (member) => member.typeId === discriminantOptionalInfo.someType,
            );
            if (!someLayout) {
              throw new Error("inline optional layout is missing Some member");
            }
            const discriminantValue = loadStoredDiscriminant();
            if (someLayout.abiTypes.length === 0) {
              return ctx.mod.nop();
            }
            if (someLayout.abiTypes.length === 1) {
              return ctx.mod.tuple.extract(discriminantValue, someLayout.abiStart);
            }
            return ctx.mod.tuple.make(
              someLayout.abiTypes.map((_, index) =>
                ctx.mod.tuple.extract(
                  discriminantValue,
                  someLayout.abiStart + index,
                ),
              ),
            );
          })()
        : undefined;
    const bindingOps: binaryen.ExpressionRef[] = [];
    const narrowedDiscriminant = (): binaryen.ExpressionRef =>
      shouldInlineUnionLayout(discriminantTypeId, ctx)
        ? coerceValueToType({
            value: loadStoredDiscriminant(),
            actualType: discriminantTypeId,
            targetType: patternTypeId,
            ctx,
            fnCtx,
          })
        : coerceExprToWasmType({
            expr: loadStoredDiscriminant(),
            targetType: wasmTypeFor(patternTypeId, ctx),
            ctx,
          });
    if (arm.pattern.kind === "type" && arm.pattern.binding) {
      if (
        typeof optionalSomePayload !== "undefined" &&
        arm.pattern.binding.kind === "identifier"
      ) {
        compilePatternInitializationFromValue({
          pattern: arm.pattern.binding,
          value: optionalSomePayload,
          valueTypeId: discriminantOptionalInfo!.innerType,
          ctx,
          fnCtx,
          ops: bindingOps,
          options: { declare: true },
        });
      } else if (
        typeof optionalSomePayload !== "undefined" &&
        arm.pattern.binding.kind === "destructure" &&
        !arm.pattern.binding.spread &&
        arm.pattern.binding.fields.length === 1 &&
        arm.pattern.binding.fields[0]!.name === "value"
      ) {
        compilePatternInitializationFromValue({
          pattern: arm.pattern.binding.fields[0]!.pattern,
          value: optionalSomePayload,
          valueTypeId: discriminantOptionalInfo!.innerType,
          ctx,
          fnCtx,
          ops: bindingOps,
          options: { declare: true },
        });
      } else {
        compilePatternInitializationFromValue({
          pattern: arm.pattern.binding,
          value: narrowedDiscriminant(),
          valueTypeId: patternTypeId,
          ctx,
          fnCtx,
          ops: bindingOps,
          options: { declare: true },
        });
      }
    } else if (arm.pattern.kind !== "type") {
      compilePatternInitializationFromValue({
        pattern: arm.pattern,
        value: narrowedDiscriminant(),
        valueTypeId: patternTypeId,
        ctx,
        fnCtx,
        ops: bindingOps,
        options: { declare: true },
      });
    }

    let restoreDiscriminantBinding: (() => void) | undefined;
    if (typeof discriminantSymbol === "number") {
      const narrowedBinding = allocateTempLocal(
        wasmTypeFor(patternTypeId, ctx),
        fnCtx,
        patternTypeId,
        ctx,
      );
      bindingOps.push(
        storeLocalValue({
          binding: narrowedBinding,
          value: coerceValueToType({
            value: narrowedDiscriminant(),
            actualType: patternTypeId,
            targetType: patternTypeId,
            ctx,
            fnCtx,
          }),
          ctx,
          fnCtx,
        }),
      );
      const originalBinding = fnCtx.bindings.get(discriminantSymbol);
      fnCtx.bindings.set(discriminantSymbol, {
        ...narrowedBinding,
        kind: "local",
        typeId: patternTypeId,
      });
      restoreDiscriminantBinding = () => {
        if (originalBinding) {
          fnCtx.bindings.set(discriminantSymbol, originalBinding);
          return;
        }
        fnCtx.bindings.delete(discriminantSymbol);
      };
    }

    const armValue = (() => {
      try {
        return compileExpr({
          exprId: arm.value,
          ctx,
          fnCtx,
          tailPosition,
        });
      } finally {
        restoreDiscriminantBinding?.();
      }
    })();

    const armExpr =
      bindingOps.length === 0
        ? armValue
        : {
            expr: ctx.mod.block(
              null,
              [...bindingOps, armValue.expr],
              binaryen.getExpressionType(armValue.expr),
            ),
            usedReturnCall: armValue.usedReturnCall,
          };

    const fallback =
      chain ??
      ({
        expr: ctx.mod.unreachable(),
        usedReturnCall: false,
      } as CompiledExpression);

    const armTypeId = expressionUsesExpectedResultType({
      exprId: arm.value,
      ctx,
    })
      ? resultTypeId
      : getValueSourceTypeId(arm.value, ctx, typeInstanceId);
    const coercedThen = coerceValueToType({
      value: armExpr.expr,
      actualType: armTypeId,
      targetType: resultTypeId,
      ctx,
      fnCtx,
    });
    const typedThen = coerceToBinaryenType(ctx, coercedThen, resultType, fnCtx);
    const typedElse = coerceToBinaryenType(ctx, fallback.expr, resultType, fnCtx);

    chain = {
      expr: ctx.mod.if(condition, typedThen, typedElse),
      usedReturnCall: armExpr.usedReturnCall && fallback.usedReturnCall,
    };
  }

  const finalExpr = chain ?? {
    expr: ctx.mod.unreachable(),
    usedReturnCall: false,
  };

  return {
    expr: ctx.mod.block(null, [initDiscriminant, finalExpr.expr], resultType),
    usedReturnCall: finalExpr.usedReturnCall,
  };
};

const compileMatchCondition = (
  patternTypeId: TypeId,
  discriminantTypeId: TypeId,
  loadDiscriminant: () => binaryen.ExpressionRef,
  discriminant: LocalBindingLocal,
  ctx: CodegenContext,
  duplicateNominals: ReadonlySet<TypeId>,
): binaryen.ExpressionRef => {
  if (
    shouldInlineUnionLayout(discriminantTypeId, ctx)
  ) {
    const layout = getInlineUnionLayout(discriminantTypeId, ctx);
    const tagValue =
      layout.abiTypes.length === 1
        ? loadDiscriminant()
        : ctx.mod.tuple.extract(
            loadDiscriminant(),
            0,
          );
    const collectTargets = (
      typeId: TypeId,
      seen: Set<TypeId>,
      targets: TypeId[],
    ): void => {
      if (seen.has(typeId)) {
        return;
      }
      seen.add(typeId);
      const desc = ctx.program.types.getTypeDesc(typeId);
      if (desc.kind === "union") {
        desc.members.forEach((member) => collectTargets(member, seen, targets));
        return;
      }
      targets.push(typeId);
    };
    const targets: TypeId[] = [];
    collectTargets(patternTypeId, new Set<TypeId>(), targets);
    const conditions = targets
      .map((target) => layout.members.find((member) => member.typeId === target))
      .filter((member): member is NonNullable<typeof member> => Boolean(member))
      .map((member) => ctx.mod.i32.eq(tagValue, ctx.mod.i32.const(member.tag)));
    if (conditions.length === 0) {
      throw new Error("match pattern requires an inline union member");
    }
    return conditions.reduce(
      (condition, test) => ctx.mod.i32.or(condition, test),
      conditions[0]!,
    );
  }
  const patternNominals = new Set<TypeId>();
  collectNominalComponents(patternTypeId, ctx, patternNominals);
  const useStrict = Array.from(patternNominals).some((nominal) =>
    duplicateNominals.has(nominal),
  );
  const makeAncestors = () =>
    structGetFieldValue({
      mod: ctx.mod,
      fieldType: ctx.rtt.extensionHelpers.i32Array,
      fieldIndex: RTT_METADATA_SLOTS.ANCESTORS,
      exprRef: loadLocalValue(discriminant, ctx),
    });

  const compileTypeTest = (typeId: TypeId): binaryen.ExpressionRef => {
    const structInfo = getStructuralTypeInfo(typeId, ctx);
    if (!structInfo) {
      throw new Error("match pattern requires a structural type");
    }
    if (structInfo.layoutKind === "value-object") {
      return refTest(
        ctx.mod,
        loadLocalValue(discriminant, ctx),
        structInfo.runtimeType,
      );
    }

    return ctx.mod.call(
      useStrict ? "__has_type" : "__extends",
      [ctx.mod.i32.const(structInfo.runtimeTypeId), makeAncestors()],
      binaryen.i32,
    );
  };

  const collectTargets = (
    typeId: TypeId,
    seen: Set<TypeId>,
    targets: TypeId[],
  ): void => {
    if (seen.has(typeId)) {
      return;
    }
    seen.add(typeId);
    const desc = ctx.program.types.getTypeDesc(typeId);
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

  return targets
    .slice(1)
    .reduce(
      (condition, typeId) => ctx.mod.i32.or(condition, compileTypeTest(typeId)),
      compileTypeTest(targets[0]!),
    );
};

export const compileWhileExpr = (
  expr: HirWhileExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
): CompiledExpression => {
  const { loopLabel, breakLabel } = allocateLoopLabels({
    fnCtx,
    prefix: `while_loop_${expr.id}`,
  });

  const conditionExpr = compileExpr({
    exprId: expr.condition,
    ctx,
    fnCtx,
  }).expr;

  const conditionCheck = ctx.mod.if(
    ctx.mod.i32.eqz(conditionExpr),
    ctx.mod.br(breakLabel),
  );

  const body = withLoopScope(
    fnCtx,
    { breakLabel, continueLabel: loopLabel },
    () => compileExpr({ exprId: expr.body, ctx, fnCtx }).expr,
  );
  const loopBody = ctx.mod.block(
    null,
    [conditionCheck, body, ctx.mod.br(loopLabel)],
    binaryen.none,
  );

  return {
    expr: ctx.mod.block(
      breakLabel,
      [ctx.mod.loop(loopLabel, loopBody)],
      binaryen.none,
    ),
    usedReturnCall: false,
  };
};

export const compileLoopExpr = (
  expr: HirLoopExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
): CompiledExpression => {
  const { loopLabel, breakLabel } = allocateLoopLabels({
    fnCtx,
    prefix: `loop_${expr.id}`,
  });
  const body = withLoopScope(
    fnCtx,
    { breakLabel, continueLabel: loopLabel },
    () => compileExpr({ exprId: expr.body, ctx, fnCtx }).expr,
  );
  const loopBody = ctx.mod.block(
    null,
    [body, ctx.mod.br(loopLabel)],
    binaryen.none,
  );
  return {
    expr: ctx.mod.block(
      breakLabel,
      [ctx.mod.loop(loopLabel, loopBody)],
      binaryen.none,
    ),
    usedReturnCall: false,
  };
};

export const compileBreakExpr = (
  expr: HirBreakExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
): CompiledExpression => {
  const target = resolveLoopScope({ fnCtx, label: expr.label });
  const ops: binaryen.ExpressionRef[] = [];

  if (typeof expr.value === "number") {
    const valueExpr = compileExpr({ exprId: expr.value, ctx, fnCtx }).expr;
    ops.push(asStatement(ctx, valueExpr, fnCtx));
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
  fnCtx: FunctionContext,
): CompiledExpression => {
  const target = resolveLoopScope({ fnCtx, label: expr.label });
  return { expr: ctx.mod.br(target.continueLabel), usedReturnCall: false };
};
const collectNominalComponents = (
  typeId: TypeId,
  ctx: CodegenContext,
  acc: Set<TypeId>,
): void => {
  const nominal = getNominalComponent(typeId, ctx);
  if (typeof nominal === "number") {
    acc.add(nominal);
    return;
  }
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "union") {
    desc.members.forEach((member) =>
      collectNominalComponents(member, ctx, acc),
    );
  }
};
