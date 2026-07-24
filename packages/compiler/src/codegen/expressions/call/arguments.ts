import binaryen from "binaryen";
import {
  refCast,
  structGetFieldValue,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  ExpressionCompiler,
  FunctionContext,
  FunctionMetadata,
  HirCallExpr,
  HirExprId,
  LocalBindingScalarAggregate,
  SymbolId,
  TypeId,
} from "../../context.js";
import type { ProgramFunctionInstanceId } from "../../../semantics/ids.js";
import type { CallArgumentPlanEntry } from "../../../semantics/typing/types.js";
import type { CallShapeSpecializationRequest } from "../../../optimize/ir.js";
import { compileOptionalNoneValue } from "../../optionals.js";
import { stableCallsiteIdFor } from "../../../stable-callsite-id.js";
import { coerceValueToType, loadStructuralField } from "../../structural.js";
import {
  abiTypeFor,
  getCallableParamAbiTypes,
  getInlineHeapBoxType,
  getMutableRefStorageType,
  getRequiredExprType,
  getSignatureSpillBoxType,
  getStructuralTypeInfo,
  lowerValueToMutableRefStorage,
  wasmTypeFor,
} from "../../types.js";
import {
  allocateAddressableLocal,
  allocateMutableRefLocal,
  allocateTempLocal,
  getRequiredBinding,
  loadLocalValue,
  loadBindingValue,
  loadBindingStorageRef,
  materializeOwnedBinding,
  storeProjectedFieldBindingValue,
  storeLocalValue,
  loadScalarAggregateBindingField,
  storeScalarAggregateBindingValue,
} from "../../locals.js";
import { boxSignatureSpillValue } from "../../signature-spill.js";
import {
  materializeProjectedElementBinding,
  tryCompileProjectedElementStorageRefExpr,
} from "../../projected-element-views.js";
import { compileCallArgExpressionsWithTemps } from "./shared.js";
import { captureMultivalueLanes } from "../../multivalue.js";
import { preserveResultAcrossOperations } from "../../result-sequencing.js";
import {
  getOrCreateScalarAggregateCallSpecialization,
  scalarAggregateParameterCanUseSpecializedAbi,
} from "../../optimization/scalar-aggregate-calls.js";
import {
  canStoreScalarAggregateExpression,
  createScalarAggregateTempBinding,
  tryStoreScalarAggregateExpression,
} from "../../optimization/scalar-aggregates.js";
import type {
  CallParam,
  CompileCallArgumentOptions,
  CompiledCallArgumentsForParams,
  PlannedCallArguments,
} from "./types.js";
import { getOrCreateCallShapeSpecialization } from "../../call-shape-specialization.js";
import { compileFieldAssignment } from "../mutations.js";

type ScalarAggregateCallArg =
  | { kind: "binding"; symbol: SymbolId; typeId: TypeId }
  | { kind: "expression"; exprId: HirExprId; typeId: TypeId };

const heapObjectScalarArgumentNeedsProducerSpecialization = ({
  exprId,
  ctx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
}): boolean => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr) {
    return true;
  }
  if (expr.exprKind === "call" || expr.exprKind === "method-call") {
    return true;
  }
  if (expr.exprKind === "block") {
    return typeof expr.value !== "number"
      ? false
      : heapObjectScalarArgumentNeedsProducerSpecialization({
          exprId: expr.value,
          ctx,
        });
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    return (
      expr.branches.some((branch) =>
        heapObjectScalarArgumentNeedsProducerSpecialization({
          exprId: branch.value,
          ctx,
        }),
      ) ||
      (typeof expr.defaultBranch === "number" &&
        heapObjectScalarArgumentNeedsProducerSpecialization({
          exprId: expr.defaultBranch,
          ctx,
        }))
    );
  }
  return false;
};

export const applyCallArgumentWritebacks = ({
  call,
  writebacks,
  ctx,
  fnCtx,
}: {
  call: import("../../context.js").CompiledExpression;
  writebacks: readonly binaryen.ExpressionRef[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): import("../../context.js").CompiledExpression => {
  if (writebacks.length === 0) {
    return call;
  }
  if (call.usedReturnCall) {
    throw new Error("call argument writeback cannot follow a return_call");
  }
  return {
    ...call,
    expr: preserveResultAcrossOperations({
      value: call.expr,
      operations: writebacks,
      ctx,
      fnCtx,
    }),
    usedReturnCall: false,
  };
};

export const compileCallArgumentsWithMetadata = ({
  call,
  meta,
  ctx,
  fnCtx,
  compileExpr,
}: {
  call: HirCallExpr;
  meta: FunctionMetadata;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): {
  args: binaryen.ExpressionRef[];
  writebacks: binaryen.ExpressionRef[];
  meta: FunctionMetadata;
} => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const typedPlan = resolveTypedCallArgumentPlan({
    callId: call.id,
    typeInstanceId,
    ctx,
  });

  const compiled = compileCallArgumentsForParamsWithDetails({
    call,
    params: meta.parameters,
    paramAbiKinds: meta.paramAbiKinds,
    meta,
    ctx,
    fnCtx,
    compileExpr,
    options: {
      typeInstanceId,
      typedPlan,
    },
  });
  return {
    args: compiled.args,
    writebacks: compiled.writebacks,
    meta: compiled.meta ?? meta,
  };
};

const callShapeSpecializationRequestFor = ({
  callId,
  callerInstanceId,
  ctx,
}: {
  callId: HirExprId;
  callerInstanceId: ProgramFunctionInstanceId | undefined;
  ctx: CodegenContext;
}): CallShapeSpecializationRequest | undefined => {
  if (!ctx.optimization || typeof callerInstanceId !== "number") {
    return undefined;
  }
  return ctx.optimization.callShapeSpecializationRequests
    .get(`${ctx.moduleId}:${callId}`)
    ?.get(callerInstanceId);
};

export const compileCallArgumentsForParamsWithDetails = ({
  call,
  params,
  paramAbiKinds,
  meta,
  ctx,
  fnCtx,
  compileExpr,
  options,
}: {
  call: HirCallExpr;
  params: readonly CallParam[];
  paramAbiKinds?: readonly string[];
  meta?: FunctionMetadata;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  options: CompileCallArgumentOptions;
}): CompiledCallArgumentsForParams => {
  const {
    typeInstanceId,
    argIndexOffset = 0,
    allowTrailingArguments = false,
    allCallArgExprIds,
    typedPlan,
  } = options;

  const fail = createCallArgumentFailure({
    call,
    params,
    argIndexOffset,
    typeInstanceId,
    ctx,
  });

  const planned = typedPlan
    ? planCallArgumentsFromTypedPlan({
        typedPlan,
        call,
        params,
        allowTrailingArguments,
        fail,
      })
    : planCallArgumentsForParamsFallback({
        call,
        params,
        ctx,
        typeInstanceId,
        allowTrailingArguments,
        argIndexOffset,
      });

  const scalarAggregateArgs = meta
    ? collectScalarAggregateCallArgs({
        plan: planned.plan,
        callArgs: call.args,
        meta,
        ctx,
        fnCtx,
      })
    : new Map<number, ScalarAggregateCallArg>();
  const tempArgIndexes = new Set(
    (ctx.effectLowering.callArgTemps.get(call.id) ?? [])
      .filter((entry) => entry.argIndex >= 0)
      .map((entry) => entry.argIndex),
  );
  const eligibleScalarAggregateArgs = new Map(
    Array.from(scalarAggregateArgs.entries()).filter(([paramIndex]) => {
      const entry = planned.plan[paramIndex];
      return (
        entry?.kind === "direct" &&
        !tempArgIndexes.has(entry.argIndex + argIndexOffset)
      );
    }),
  );
  const resolvedMeta =
    meta && eligibleScalarAggregateArgs.size > 0
      ? (getOrCreateScalarAggregateCallSpecialization({
          ctx,
          meta,
          paramIndexes: new Set(eligibleScalarAggregateArgs.keys()),
        }) ?? meta)
      : meta;
  const callShapeRequest = meta
    ? callShapeSpecializationRequestFor({
        callId: call.id,
        callerInstanceId: fnCtx.instanceId ?? typeInstanceId,
        ctx,
      })
    : undefined;
  const callShapeMeta =
    resolvedMeta && callShapeRequest && typedPlan
      ? getOrCreateCallShapeSpecialization({
          ctx,
          meta: resolvedMeta,
          request: callShapeRequest,
          typedPlan,
        })
      : undefined;
  const activeMeta = callShapeMeta ?? resolvedMeta;
  const selectedScalarParams = new Set(
    activeMeta?.scalarAggregateParamIndexes ?? [],
  );
  const selectedScalarArgs = new Map(
    Array.from(eligibleScalarAggregateArgs.entries()).filter(([paramIndex]) =>
      selectedScalarParams.has(paramIndex),
    ),
  );
  const selectedScalarArgsByArgIndex = new Map<
    number,
    ScalarAggregateCallArg
  >();
  planned.plan.forEach((entry, paramIndex) => {
    if (entry.kind !== "direct") {
      return;
    }
    const scalarArg = selectedScalarArgs.get(paramIndex);
    if (scalarArg) {
      selectedScalarArgsByArgIndex.set(entry.argIndex, scalarArg);
    }
  });
  const scalarOverrideArgIndexes = new Set(selectedScalarArgsByArgIndex.keys());

  const consumedArgs = call.args.slice(0, planned.consumedArgCount);
  const preservedArgIndexes = collectPreservedStorageRefArgIndexes({
    plan: planned.plan,
    paramAbiKinds: activeMeta?.paramAbiKinds ?? paramAbiKinds,
  });
  const compiledArgs = compileCallArgExpressionsWithTemps({
    callId: call.id,
    args: consumedArgs,
    argIndexOffset,
    allArgExprIds: allCallArgExprIds ?? call.args.map((arg) => arg.expr),
    expectedTypeIdAt: (index) => {
      if (!activeMeta?.callShape) {
        return planned.expectedTypeByArgIndex.get(index);
      }
      const parameterIndex = planned.plan.findIndex(
        (entry) => entry.kind === "direct" && entry.argIndex === index,
      );
      return parameterIndex >= 0
        ? activeMeta.paramTypeIds[parameterIndex]
        : planned.expectedTypeByArgIndex.get(index);
    },
    preserveStorageRefsAt: (index) =>
      preservedArgIndexes.has(index + argIndexOffset),
    compileOverrideAt: (_arg, index) => {
      const scalarArg = selectedScalarArgsByArgIndex.get(index);
      if (!scalarArg) {
        return undefined;
      }
      return {
        expr: scalarAggregateArgumentValueForCallArg({
          arg: scalarArg,
          ctx,
          fnCtx,
          compileExpr,
        }),
        skipCoercion: true,
      };
    },
    ctx,
    fnCtx,
    compileExpr,
  });

  const writebacks: binaryen.ExpressionRef[] = [];
  const args = materializeCallArgumentPlan({
    plan: planned.plan,
    compiledArgs,
    callArgs: call.args,
    paramTypeIds:
      activeMeta?.paramTypeIds ?? params.map((param) => param.typeId),
    paramAbiKinds: activeMeta?.paramAbiKinds ?? paramAbiKinds,
    paramAbiTypes:
      activeMeta?.paramAbiTypes ??
      params.map((param) => {
        const payload = getCallableParamAbiTypes({
          typeId: param.typeId,
          bindingKind: param.bindingKind,
          defaulted: param.defaulted,
          ctx,
        });
        return param.defaulted ? [...payload, binaryen.i32] : payload;
      }),
    presenceEncodedParams:
      activeMeta?.parameters.map(
        (param) => param.defaulted === true && !activeMeta.callShape,
      ) ?? params.map((param) => param.defaulted === true),
    callShapeParameterStates: activeMeta?.callShape?.parameterStates,
    scalarOverrideArgIndexes,
    typeInstanceId,
    ctx,
    fnCtx,
    compileExpr,
    writebacks,
  });

  return {
    args,
    writebacks,
    consumedArgCount: planned.consumedArgCount,
    meta: activeMeta ?? meta,
  };
};

const collectScalarAggregateCallArgs = ({
  plan,
  callArgs,
  meta,
  ctx,
  fnCtx,
}: {
  plan: readonly CallArgumentPlanEntry[];
  callArgs: readonly HirCallExpr["args"][number][];
  meta: FunctionMetadata;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): Map<number, ScalarAggregateCallArg> => {
  const bindings = new Map<number, ScalarAggregateCallArg>();
  plan.forEach((entry, paramIndex) => {
    if (
      entry.kind !== "direct" ||
      entry.argIndex !== 0 ||
      meta.paramAbiKinds[paramIndex] !== "direct" ||
      !scalarAggregateParameterCanUseSpecializedAbi({ meta, paramIndex, ctx })
    ) {
      return;
    }
    const argExprId = callArgs[entry.argIndex]?.expr;
    const argExpr = ctx.module.hir.expressions.get(argExprId);
    if (!argExpr) {
      return;
    }
    if (argExpr.exprKind === "identifier") {
      const binding = fnCtx.bindings.get(argExpr.symbol);
      if (
        binding?.kind === "scalar-aggregate" &&
        binding.typeId === meta.paramTypeIds[paramIndex]
      ) {
        bindings.set(paramIndex, {
          kind: "binding",
          symbol: argExpr.symbol,
          typeId: meta.paramTypeIds[paramIndex]!,
        });
      }
      return;
    }
    const typeId = meta.paramTypeIds[paramIndex];
    const structInfo =
      typeof typeId === "number"
        ? getStructuralTypeInfo(typeId, ctx)
        : undefined;
    if (
      typeof argExprId !== "number" ||
      typeof typeId !== "number" ||
      !structInfo ||
      (structInfo.layoutKind === "heap-object" &&
        heapObjectScalarArgumentNeedsProducerSpecialization({
          exprId: argExprId,
          ctx,
        })) ||
      !canStoreScalarAggregateExpression({
        exprId: argExprId,
        targetTypeId: typeId,
        structInfo,
        ctx,
      })
    ) {
      return;
    }
    bindings.set(paramIndex, { kind: "expression", exprId: argExprId, typeId });
  });
  return bindings;
};

const scalarAggregateArgumentValueForCallArg = ({
  arg,
  ctx,
  fnCtx,
  compileExpr,
}: {
  arg: ScalarAggregateCallArg;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): binaryen.ExpressionRef => {
  if (arg.kind === "binding") {
    const binding = getRequiredBinding(arg.symbol, ctx, fnCtx);
    if (binding.kind === "scalar-aggregate" && binding.typeId === arg.typeId) {
      return scalarAggregateArgumentValue({ binding, ctx, fnCtx });
    }
    const structInfo = getStructuralTypeInfo(arg.typeId, ctx);
    if (!structInfo) {
      throw new Error(
        "scalar aggregate binding argument requires a structural type",
      );
    }
    const scalarBinding = createScalarAggregateTempBinding({
      typeId: arg.typeId,
      structInfo,
      ctx,
      fnCtx,
    });
    const setup = [
      storeScalarAggregateBindingValue({
        binding: scalarBinding,
        value: loadBindingValue(binding, ctx, fnCtx),
        ctx,
        fnCtx,
      }),
    ];
    const value = scalarAggregateArgumentValue({
      binding: scalarBinding,
      ctx,
      fnCtx,
    });
    return ctx.mod.block(
      null,
      [...setup, value],
      binaryen.getExpressionType(value),
    );
  }
  const structInfo = getStructuralTypeInfo(arg.typeId, ctx);
  if (!structInfo) {
    throw new Error(
      "scalar aggregate call argument requires a structural type",
    );
  }
  const binding = createScalarAggregateTempBinding({
    typeId: arg.typeId,
    structInfo,
    ctx,
    fnCtx,
  });
  const setup = tryStoreScalarAggregateExpression({
    binding,
    exprId: arg.exprId,
    targetTypeId: arg.typeId,
    ctx,
    fnCtx,
    compileExpr,
  });
  if (!setup) {
    throw new Error("scalar aggregate call argument is not scalarizable");
  }
  const value = scalarAggregateArgumentValue({ binding, ctx, fnCtx });
  return ctx.mod.block(
    null,
    [...setup, value],
    binaryen.getExpressionType(value),
  );
};

const scalarAggregateArgumentValue = ({
  binding,
  ctx,
  fnCtx,
}: {
  binding: LocalBindingScalarAggregate;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const setup: binaryen.ExpressionRef[] = [];
  const lanes: binaryen.ExpressionRef[] = [];
  const laneTypes: binaryen.Type[] = [];

  binding.structInfo.fields.forEach((field) => {
    const value = loadScalarAggregateBindingField({
      binding,
      fieldName: field.name,
      ctx,
    });
    if (typeof value !== "number") {
      throw new Error(`scalar aggregate missing field ${field.name}`);
    }
    const fieldAbiTypes = [...binaryen.expandType(field.wasmType)];
    laneTypes.push(...fieldAbiTypes);
    if (fieldAbiTypes.length <= 1) {
      lanes.push(value);
      return;
    }
    const captured = captureMultivalueLanes({
      value,
      abiTypes: fieldAbiTypes,
      ctx,
      fnCtx,
    });
    setup.push(...captured.setup);
    lanes.push(...captured.lanes);
  });

  const value =
    lanes.length === 1
      ? lanes[0]!
      : ctx.mod.tuple.make(lanes as binaryen.ExpressionRef[]);
  if (setup.length === 0) {
    return value;
  }
  return ctx.mod.block(null, [...setup, value], abiTypeFor(laneTypes));
};

export const resolveTypedCallArgumentPlan = ({
  callId,
  typeInstanceId,
  ctx,
}: {
  callId: HirExprId;
  typeInstanceId: ProgramFunctionInstanceId | undefined;
  ctx: CodegenContext;
}): readonly CallArgumentPlanEntry[] | undefined => {
  const callInfo = ctx.program.calls.getCallInfo(ctx.moduleId, callId);
  if (!callInfo.argPlans || callInfo.argPlans.size === 0) {
    return undefined;
  }

  if (typeof typeInstanceId === "number") {
    const byInstance = callInfo.argPlans.get(typeInstanceId);
    if (byInstance) {
      return byInstance;
    }
  }

  return callInfo.argPlans.size === 1
    ? callInfo.argPlans.values().next().value
    : undefined;
};

export const sliceTypedCallArgumentPlan = ({
  typedPlan,
  paramOffset,
  argOffset,
}: {
  typedPlan: readonly CallArgumentPlanEntry[];
  paramOffset: number;
  argOffset: number;
}): readonly CallArgumentPlanEntry[] =>
  typedPlan.slice(paramOffset).map((entry) => {
    if (entry.kind === "direct") {
      if (entry.argIndex < argOffset) {
        throw new Error(
          `typed call argument plan direct index ${entry.argIndex} is before slice offset ${argOffset}`,
        );
      }
      return {
        kind: "direct",
        argIndex: entry.argIndex - argOffset,
      };
    }

    if (entry.kind === "container-field") {
      if (entry.containerArgIndex < argOffset) {
        throw new Error(
          `typed call argument plan container index ${entry.containerArgIndex} is before slice offset ${argOffset}`,
        );
      }
      return {
        kind: "container-field",
        containerArgIndex: entry.containerArgIndex - argOffset,
        fieldName: entry.fieldName,
        targetTypeId: entry.targetTypeId,
      };
    }

    if (entry.kind === "stable-callsite-id") {
      return {
        kind: "stable-callsite-id",
        targetTypeId: entry.targetTypeId,
        value: entry.value,
      };
    }

    return { kind: entry.kind, targetTypeId: entry.targetTypeId };
  });

const createCallArgumentFailure = ({
  call,
  params,
  argIndexOffset,
  typeInstanceId,
  ctx,
}: {
  call: HirCallExpr;
  params: readonly CallParam[];
  argIndexOffset: number;
  typeInstanceId: ProgramFunctionInstanceId | undefined;
  ctx: CodegenContext;
}): ((detail: string) => never) => {
  const calleeName = describeCallCalleeName({ call, ctx });
  const paramSummary = params
    .map(
      (param, index) =>
        `${index}:${param.label ?? "_"}${param.optional ? "?" : ""}@${param.typeId}`,
    )
    .join(", ");

  const argSummary = call.args
    .map((arg, index) => {
      const argType = getRequiredExprType(arg.expr, ctx, typeInstanceId);
      return `${index + argIndexOffset}:${arg.label ?? "_"}@expr${arg.expr}:type${argType}`;
    })
    .join(", ");

  return (detail: string): never => {
    throw new Error(
      `call argument count mismatch for ${calleeName} (call ${call.id} in ${ctx.moduleId}): ${detail}; params=[${paramSummary}]; args=[${argSummary}]`,
    );
  };
};

const describeCallCalleeName = ({
  call,
  ctx,
}: {
  call: HirCallExpr;
  ctx: CodegenContext;
}): string => {
  const callee = ctx.module.hir.expressions.get(call.callee);
  if (!callee) return "<unknown>";

  if (callee.exprKind === "identifier") {
    const calleeId = ctx.program.symbols.canonicalIdOf(
      ctx.moduleId,
      callee.symbol,
    );
    return ctx.program.symbols.getName(calleeId) ?? `${callee.symbol}`;
  }

  return callee.exprKind === "overload-set" ? callee.name : callee.exprKind;
};

const planCallArgumentsForParamsFallback = ({
  call,
  params,
  ctx,
  typeInstanceId,
  allowTrailingArguments,
  argIndexOffset,
}: {
  call: HirCallExpr;
  params: readonly CallParam[];
  ctx: CodegenContext;
  typeInstanceId: ProgramFunctionInstanceId | undefined;
  allowTrailingArguments: boolean;
  argIndexOffset: number;
}): PlannedCallArguments => {
  const fail = createCallArgumentFailure({
    call,
    params,
    argIndexOffset,
    typeInstanceId,
    ctx,
  });

  const labelsCompatible = (
    param: CallParam,
    argLabel: string | undefined,
  ): boolean => {
    if (!param.label) {
      return argLabel === undefined;
    }
    return argLabel === param.label;
  };

  const allowsOmittedArgument = (param: CallParam): boolean =>
    param.optional === true ||
    param.defaulted === true ||
    ctx.program.optionals.getOptionalInfo(ctx.moduleId, param.typeId) !==
      undefined;
  const omittedArgumentPlanEntry = (
    param: CallParam,
    paramIndex: number,
  ): CallArgumentPlanEntry =>
    param.synthetic === "stable-callsite-id"
      ? {
          kind: "stable-callsite-id",
          targetTypeId: param.typeId,
          value: stableCallsiteIdFor(call.span, `${paramIndex}`),
        }
      : param.defaulted
        ? { kind: "omitted-default", targetTypeId: param.typeId }
        : { kind: "omitted-optional", targetTypeId: param.typeId };

  const plan: CallArgumentPlanEntry[] = [];
  const expectedTypeByArgIndex = new Map<number, TypeId>();
  let argIndex = 0;
  let paramIndex = 0;

  while (paramIndex < params.length) {
    const param = params[paramIndex]!;
    const arg = call.args[argIndex];

    if (!arg) {
      if (allowsOmittedArgument(param)) {
        plan.push(omittedArgumentPlanEntry(param, paramIndex));
        paramIndex += 1;
        continue;
      }
      fail("missing required argument");
    }

    if (param.label && arg.label === undefined) {
      const containerTypeId = getRequiredExprType(
        arg.expr,
        ctx,
        typeInstanceId,
      );
      const containerInfo = getStructuralTypeInfo(containerTypeId, ctx);
      if (containerInfo) {
        let cursor = paramIndex;
        while (cursor < params.length) {
          const runParam = params[cursor]!;
          if (!runParam.label) {
            break;
          }

          const field = containerInfo.fieldMap.get(runParam.label);
          if (field) {
            plan.push({
              kind: "container-field",
              containerArgIndex: argIndex,
              fieldName: runParam.label,
              targetTypeId: runParam.typeId,
            });
            cursor += 1;
            continue;
          }

          if (allowsOmittedArgument(runParam)) {
            plan.push(omittedArgumentPlanEntry(runParam, cursor));
            cursor += 1;
            continue;
          }

          fail(`missing required labeled argument ${runParam.label}`);
        }

        if (cursor > paramIndex) {
          paramIndex = cursor;
          argIndex += 1;
          continue;
        }
      }
    }

    if (labelsCompatible(param, arg.label)) {
      plan.push({ kind: "direct", argIndex });
      expectedTypeByArgIndex.set(argIndex, param.typeId);
      paramIndex += 1;
      argIndex += 1;
      continue;
    }

    if (allowsOmittedArgument(param)) {
      plan.push(omittedArgumentPlanEntry(param, paramIndex));
      paramIndex += 1;
      continue;
    }

    fail("argument/parameter mismatch");
  }

  if (!allowTrailingArguments && argIndex < call.args.length) {
    fail(`received ${call.args.length - argIndex} extra argument(s)`);
  }

  return {
    plan,
    expectedTypeByArgIndex,
    consumedArgCount: argIndex,
  };
};

const planCallArgumentsFromTypedPlan = ({
  typedPlan,
  call,
  params,
  allowTrailingArguments,
  fail,
}: {
  typedPlan: readonly CallArgumentPlanEntry[];
  call: HirCallExpr;
  params: readonly CallParam[];
  allowTrailingArguments: boolean;
  fail: (detail: string) => never;
}): PlannedCallArguments => {
  if (typedPlan.length !== params.length) {
    fail(
      `typed plan length mismatch (expected ${params.length}, got ${typedPlan.length})`,
    );
  }

  const expectedTypeByArgIndex = new Map<number, TypeId>();
  const plan: CallArgumentPlanEntry[] = [];
  let consumedArgCount = 0;

  typedPlan.forEach((entry, index) => {
    const param = params[index];
    if (!param) {
      fail(`typed plan references missing parameter at index ${index}`);
    }

    const currentParam = param!;
    if (entry.kind === "direct") {
      if (entry.argIndex < 0 || entry.argIndex >= call.args.length) {
        fail(`typed plan direct arg index ${entry.argIndex} is out of range`);
      }
      plan.push(entry);
      expectedTypeByArgIndex.set(entry.argIndex, currentParam.typeId);
      consumedArgCount = Math.max(consumedArgCount, entry.argIndex + 1);
      return;
    }

    if (entry.kind === "omitted-default" || entry.kind === "omitted-optional") {
      plan.push({
        kind: entry.kind,
        targetTypeId: currentParam.typeId,
      });
      return;
    }

    if (entry.kind === "stable-callsite-id") {
      plan.push({
        kind: "stable-callsite-id",
        targetTypeId: currentParam.typeId,
        value: entry.value,
      });
      return;
    }

    if (
      entry.containerArgIndex < 0 ||
      entry.containerArgIndex >= call.args.length
    ) {
      fail(
        `typed plan container arg index ${entry.containerArgIndex} is out of range`,
      );
    }

    plan.push({
      kind: "container-field",
      containerArgIndex: entry.containerArgIndex,
      fieldName: entry.fieldName,
      targetTypeId: currentParam.typeId,
    });
    consumedArgCount = Math.max(consumedArgCount, entry.containerArgIndex + 1);
  });

  if (!allowTrailingArguments && consumedArgCount < call.args.length) {
    fail(`received ${call.args.length - consumedArgCount} extra argument(s)`);
  }

  return {
    plan,
    expectedTypeByArgIndex,
    consumedArgCount,
  };
};

const materializeCallArgumentPlan = ({
  plan,
  compiledArgs,
  callArgs,
  paramTypeIds,
  paramAbiKinds,
  paramAbiTypes,
  presenceEncodedParams,
  callShapeParameterStates,
  scalarOverrideArgIndexes,
  typeInstanceId,
  ctx,
  fnCtx,
  compileExpr,
  writebacks,
}: {
  plan: readonly CallArgumentPlanEntry[];
  compiledArgs: readonly binaryen.ExpressionRef[];
  callArgs: readonly HirCallExpr["args"][number][];
  paramTypeIds: readonly TypeId[];
  paramAbiKinds?: readonly string[];
  paramAbiTypes: readonly (readonly binaryen.Type[])[];
  presenceEncodedParams: readonly boolean[];
  callShapeParameterStates?: readonly import("../../../optimize/ir.js").CallShapeParameterState[];
  scalarOverrideArgIndexes?: ReadonlySet<number>;
  typeInstanceId: ProgramFunctionInstanceId | undefined;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  writebacks: binaryen.ExpressionRef[];
}): binaryen.ExpressionRef[] => {
  const containerTemps = new Map<
    number,
    ReturnType<typeof allocateTempLocal>
  >();
  const initializedContainers = new Set<number>();
  const mutableRefContainerArgs = new Set(
    plan.flatMap((entry, index) =>
      entry.kind === "container-field" &&
      paramAbiKinds?.[index] === "mutable_ref"
        ? [entry.containerArgIndex]
        : [],
    ),
  );

  return plan.map((entry, paramIndex) => {
    const abiKind = paramAbiKinds?.[paramIndex];
    const paramTypeId = paramTypeIds[paramIndex];
    const presenceEncoded = presenceEncodedParams[paramIndex] === true;
    const fullAbiTypes = paramAbiTypes[paramIndex] ?? [];
    const payloadAbiTypes = presenceEncoded
      ? fullAbiTypes.slice(0, -1)
      : fullAbiTypes;
    const encodeProvided = (
      payload: binaryen.ExpressionRef,
    ): binaryen.ExpressionRef =>
      presenceEncoded
        ? appendArgumentPresence({
            payload,
            payloadAbiTypes,
            typeId: paramTypeId,
            present: true,
            ctx,
            fnCtx,
          })
        : payload;
    if (entry.kind === "direct") {
      const payload = lowerCallArgumentForAbi({
        argExprId: callArgs[entry.argIndex]?.expr,
        argValue: compiledArgs[entry.argIndex]!,
        paramTypeId,
        abiKind,
        scalarOverride: scalarOverrideArgIndexes?.has(entry.argIndex) ?? false,
        ctx,
        fnCtx,
        compileExpr,
        writebacks,
      });
      return encodeProvided(payload);
    }

    if (entry.kind === "omitted-default") {
      if (callShapeParameterStates?.[paramIndex] === "omitted") {
        return ctx.mod.nop();
      }
      if (!presenceEncoded) {
        throw new Error("omitted default requires an internal presence lane");
      }
      return absentArgumentValue({ payloadAbiTypes, ctx });
    }

    if (entry.kind === "omitted-optional") {
      if (callShapeParameterStates?.[paramIndex] === "omitted") {
        return ctx.mod.nop();
      }
      return lowerCallArgumentForAbi({
        argValue: compileOptionalNoneValue({
          targetTypeId: entry.targetTypeId,
          ctx,
          fnCtx,
        }),
        paramTypeId,
        abiKind,
        ctx,
        fnCtx,
        compileExpr,
        writebacks,
      });
    }

    if (entry.kind === "stable-callsite-id") {
      if (callShapeParameterStates?.[paramIndex] === "stable-callsite-id") {
        return ctx.mod.i32.const(entry.value);
      }
      const payload = lowerCallArgumentForAbi({
        argValue: ctx.mod.i32.const(entry.value),
        paramTypeId,
        abiKind,
        ctx,
        fnCtx,
        compileExpr,
        writebacks,
      });
      return encodeProvided(payload);
    }

    const containerArg = callArgs[entry.containerArgIndex]!;
    const containerTypeId = getRequiredExprType(
      containerArg.expr,
      ctx,
      typeInstanceId,
    );
    const containerInfo = getStructuralTypeInfo(containerTypeId, ctx);
    if (!containerInfo) {
      throw new Error("labeled-argument container requires a structural value");
    }

    const field = containerInfo.fieldMap.get(entry.fieldName);
    if (!field) {
      throw new Error(
        `missing field ${entry.fieldName} in labeled-argument container`,
      );
    }
    const fieldTargetTypeId =
      callShapeParameterStates?.[paramIndex] === "provided" &&
      typeof paramTypeId === "number"
        ? paramTypeId
        : entry.targetTypeId;

    const scalarFieldValue =
      abiKind === "mutable_ref"
        ? undefined
        : loadScalarContainerFieldValue({
            containerExprId: containerArg.expr,
            fieldName: entry.fieldName,
            ctx,
            fnCtx,
          });
    if (typeof scalarFieldValue === "number") {
      return encodeProvided(
        lowerCallArgumentForAbi({
          argValue: coerceValueToType({
            value: scalarFieldValue,
            actualType: field.typeId,
            targetType: fieldTargetTypeId,
            ctx,
            fnCtx,
          }),
          paramTypeId,
          abiKind,
          ctx,
          fnCtx,
          compileExpr,
          writebacks,
        }),
      );
    }

    const existingTemp = containerTemps.get(entry.containerArgIndex);
    const temp =
      existingTemp ??
      (() => {
        const created = mutableRefContainerArgs.has(entry.containerArgIndex)
          ? allocateAddressableLocal({
              typeId: containerTypeId,
              ctx,
              fnCtx,
            })
          : allocateTempLocal(
              containerInfo.interfaceType,
              fnCtx,
              containerTypeId,
              ctx,
            );
        containerTemps.set(entry.containerArgIndex, created);
        return created;
      })();
    const initOps = initializedContainers.has(entry.containerArgIndex)
      ? []
      : [
          storeLocalValue({
            binding: temp,
            value: compiledArgs[entry.containerArgIndex]!,
            ctx,
            fnCtx,
          }),
        ];
    initializedContainers.add(entry.containerArgIndex);

    const fieldExprId = resolveContainerFieldValueExprId({
      containerExprId: containerArg.expr,
      fieldName: entry.fieldName,
      ctx,
    });
    const addressableFieldSymbol =
      typeof fieldExprId === "number"
        ? resolveAddressableIdentifierSymbol({
            exprId: fieldExprId,
            ctx,
          })
        : undefined;
    if (
      abiKind === "mutable_ref" &&
      typeof addressableFieldSymbol === "number"
    ) {
      const fieldBinding = getRequiredBinding(
        addressableFieldSymbol,
        ctx,
        fnCtx,
      );
      const result = lowerCallArgumentForAbi({
        argExprId: fieldExprId,
        argValue: loadBindingValue(fieldBinding, ctx, fnCtx),
        paramTypeId,
        abiKind,
        ctx,
        fnCtx,
        compileExpr,
        writebacks,
      });
      return encodeProvided(
        initOps.length === 0
          ? result
          : ctx.mod.block(
              null,
              [...initOps, result],
              binaryen.getExpressionType(result),
            ),
      );
    }

    const loaded = loadStructuralField({
      structInfo: containerInfo,
      field,
      pointer: () => loadLocalValue(temp, ctx),
      ctx,
    });
    const coerced = coerceValueToType({
      value: loaded,
      actualType: field.typeId,
      targetType: fieldTargetTypeId,
      ctx,
      fnCtx,
    });
    const containerFieldStorageRef =
      typeof fieldExprId === "number"
        ? undefined
        : tryCompileContainerFieldStorageRef({
            containerExprId: containerArg.expr,
            containerTypeId,
            containerInfo,
            field,
            temp,
            ctx,
            fnCtx,
          });

    const result = lowerCallArgumentForAbi({
      argExprId: fieldExprId,
      argValue: coerced,
      addressableValue: containerFieldStorageRef,
      paramTypeId,
      abiKind,
      ctx,
      fnCtx,
      compileExpr,
      writebacks,
    });
    if (initOps.length === 0) {
      return encodeProvided(result);
    }
    return encodeProvided(
      ctx.mod.block(
        null,
        [...initOps, result],
        binaryen.getExpressionType(result),
      ),
    );
  });
};

const appendArgumentPresence = ({
  payload,
  payloadAbiTypes,
  typeId,
  present,
  ctx,
  fnCtx,
}: {
  payload: binaryen.ExpressionRef;
  payloadAbiTypes: readonly binaryen.Type[];
  typeId?: TypeId;
  present: boolean;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const normalizedPayload =
    typeof typeId === "number" &&
    payloadAbiTypes.length === 1 &&
    getSignatureSpillBoxType({ typeId, ctx }) === payloadAbiTypes[0] &&
    binaryen.getExpressionType(payload) !== payloadAbiTypes[0]
      ? boxSignatureSpillValue({ value: payload, typeId, ctx, fnCtx })
      : payload;
  const captured = captureMultivalueLanes({
    value: normalizedPayload,
    abiTypes: payloadAbiTypes,
    ctx,
    fnCtx,
  });
  const value = ctx.mod.tuple.make([
    ...captured.lanes,
    ctx.mod.i32.const(present ? 1 : 0),
  ]);
  return captured.setup.length === 0
    ? value
    : ctx.mod.block(
        null,
        [...captured.setup, value],
        abiTypeFor([...payloadAbiTypes, binaryen.i32]),
      );
};

const absentArgumentValue = ({
  payloadAbiTypes,
  ctx,
}: {
  payloadAbiTypes: readonly binaryen.Type[];
  ctx: CodegenContext;
}): binaryen.ExpressionRef =>
  ctx.mod.tuple.make([
    ...payloadAbiTypes.map((type) => defaultValueForAbiType(type, ctx)),
    ctx.mod.i32.const(0),
  ]);

const defaultValueForAbiType = (
  type: binaryen.Type,
  ctx: CodegenContext,
): binaryen.ExpressionRef => {
  if (type === binaryen.i32) return ctx.mod.i32.const(0);
  if (type === binaryen.i64) return ctx.mod.i64.const(0, 0);
  if (type === binaryen.f32) return ctx.mod.f32.const(0);
  if (type === binaryen.f64) return ctx.mod.f64.const(0);
  return ctx.mod.ref.null(type);
};

const loadScalarContainerFieldValue = ({
  containerExprId,
  fieldName,
  ctx,
  fnCtx,
}: {
  containerExprId: HirExprId;
  fieldName: string;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef | undefined => {
  const expr = ctx.module.hir.expressions.get(containerExprId);
  if (expr?.exprKind !== "identifier") {
    return undefined;
  }
  const binding = fnCtx.bindings.get(expr.symbol);
  if (binding?.kind !== "scalar-aggregate") {
    return undefined;
  }
  return loadScalarAggregateBindingField({
    binding,
    fieldName,
    ctx,
  });
};

const collectPreservedStorageRefArgIndexes = ({
  plan,
  paramAbiKinds,
}: {
  plan: readonly CallArgumentPlanEntry[];
  paramAbiKinds?: readonly string[];
}): ReadonlySet<number> => {
  const usage = new Map<number, boolean>();

  plan.forEach((entry, paramIndex) => {
    if (entry.kind !== "direct") {
      return;
    }
    const preserves = paramAbiKinds?.[paramIndex] === "readonly_ref";
    const existing = usage.get(entry.argIndex);
    usage.set(
      entry.argIndex,
      existing === undefined ? preserves : existing && preserves,
    );
  });

  return new Set(
    Array.from(usage.entries())
      .filter(([, preserves]) => preserves)
      .map(([argIndex]) => argIndex),
  );
};

const lowerCallArgumentForAbi = ({
  argExprId,
  argValue,
  addressableValue,
  paramTypeId,
  abiKind,
  scalarOverride = false,
  ctx,
  fnCtx,
  compileExpr,
  writebacks,
}: {
  argExprId?: HirExprId;
  argValue: binaryen.ExpressionRef;
  addressableValue?: binaryen.ExpressionRef;
  paramTypeId?: TypeId;
  abiKind?: string;
  scalarOverride?: boolean;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  writebacks: binaryen.ExpressionRef[];
}): binaryen.ExpressionRef => {
  if (abiKind !== "readonly_ref" && abiKind !== "mutable_ref") {
    if (!scalarOverride && typeof argExprId === "number") {
      const argExpr = ctx.module.hir.expressions.get(argExprId);
      if (argExpr?.exprKind === "identifier") {
        const binding = fnCtx.bindings.get(argExpr.symbol);
        if (
          binding?.kind === "scalar-aggregate" &&
          binding.structInfo.layoutKind === "heap-object"
        ) {
          if (typeof binding.typeId !== "number") {
            throw new Error("scalar aggregate binding is missing its type id");
          }
          const materialized = materializeOwnedBinding({
            symbol: argExpr.symbol,
            ctx,
            fnCtx,
          });
          const value = loadBindingValue(materialized.binding, ctx, fnCtx);
          const coerced = coerceValueToType({
            value,
            actualType: binding.typeId,
            targetType: paramTypeId,
            ctx,
            fnCtx,
          });
          return materialized.setup.length === 0
            ? coerced
            : ctx.mod.block(
                null,
                [...materialized.setup, coerced],
                binaryen.getExpressionType(coerced),
              );
        }
      }
    }
    return argValue;
  }
  if (typeof paramTypeId !== "number") {
    throw new Error(
      "ref ABI argument lowering requires a concrete parameter type",
    );
  }
  const argExpr =
    typeof argExprId === "number"
      ? ctx.module.hir.expressions.get(argExprId)
      : undefined;
  const mutablePlaceExpr =
    abiKind === "mutable_ref" && typeof argExprId === "number"
      ? resolveMutablePlaceExpression({ exprId: argExprId, ctx })
      : argExpr;
  if (
    abiKind === "mutable_ref" &&
    mutablePlaceExpr?.exprKind === "field-access"
  ) {
    const inlineStorageType = getInlineHeapBoxType({
      typeId: paramTypeId,
      ctx,
    });
    const mutableStorageType = getMutableRefStorageType({
      typeId: paramTypeId,
      ctx,
    });
    if (typeof mutableStorageType !== "number") {
      throw new Error(
        `mutable field argument requires addressable storage for ${paramTypeId}`,
      );
    }
    if (inlineStorageType === mutableStorageType) {
      return lowerValueToMutableRefStorage({
        value: argValue,
        typeId: paramTypeId,
        targetType: mutableStorageType,
        ctx,
      });
    }
    const storage = allocateMutableRefLocal({
      typeId: paramTypeId,
      ctx,
      fnCtx,
    });
    const pointer = loadBindingStorageRef(storage, ctx);
    if (!pointer) {
      throw new Error(
        `mutable field argument requires addressable storage for ${paramTypeId}`,
      );
    }
    writebacks.push(
      compileFieldAssignment({
        targetExpr: mutablePlaceExpr,
        value: loadBindingValue(storage, ctx, fnCtx),
        valueTypeId: paramTypeId,
        ctx,
        fnCtx,
        compileExpr,
      }),
    );
    return ctx.mod.block(
      null,
      [
        storeLocalValue({
          binding: storage,
          value: argValue,
          ctx,
          fnCtx,
        }),
        pointer,
      ],
      storage.storageType,
    );
  }
  if (addressableValue) {
    return addressableValue;
  }
  const addressableSymbol =
    typeof argExprId === "number"
      ? resolveAddressableIdentifierSymbol({ exprId: argExprId, ctx })
      : undefined;
  if (typeof addressableSymbol === "number") {
    const existing = getRequiredBinding(addressableSymbol, ctx, fnCtx);
    const pointer = loadBindingStorageRef(existing, ctx);
    if (pointer) {
      return pointer;
    }
    if (abiKind === "mutable_ref") {
      if (existing.kind === "projected-field-ref") {
        const storage = allocateMutableRefLocal({
          typeId: paramTypeId,
          ctx,
          fnCtx,
        });
        const storagePointer = loadBindingStorageRef(storage, ctx);
        if (!storagePointer) {
          throw new Error(
            `projected mutable argument requires addressable storage (type ${paramTypeId})`,
          );
        }
        writebacks.push(
          storeProjectedFieldBindingValue({
            binding: existing,
            value: loadBindingValue(storage, ctx, fnCtx),
            valueTypeId: paramTypeId,
            ctx,
            fnCtx,
          }),
        );
        return ctx.mod.block(
          null,
          [
            storeLocalValue({
              binding: storage,
              value: argValue,
              ctx,
              fnCtx,
            }),
            storagePointer,
          ],
          storage.storageType,
        );
      }
      const materialized =
        existing.kind === "projected-element-ref"
          ? materializeProjectedElementBinding({
              symbol: addressableSymbol,
              binding: existing,
              ctx,
              fnCtx,
            })
          : existing.kind === "scalar-aggregate"
            ? materializeOwnedBinding({
                symbol: addressableSymbol,
                ctx,
                fnCtx,
              })
            : undefined;
      if (existing.kind === "scalar-aggregate" && materialized) {
        const materializedPointer = loadBindingStorageRef(
          materialized.binding,
          ctx,
        );
        if (!materializedPointer) {
          throw new Error(
            `mutable ref call argument requires addressable temp storage (type ${paramTypeId})`,
          );
        }
        return materialized.setup.length === 0
          ? materializedPointer
          : ctx.mod.block(
              null,
              [...materialized.setup, materializedPointer],
              materialized.binding.storageType,
            );
      }
      const ownedValue = materialized
        ? loadBindingValue(materialized.binding, ctx, fnCtx)
        : argValue;
      const owned = allocateMutableRefLocal({
        typeId: paramTypeId,
        ctx,
        fnCtx,
      });
      fnCtx.bindings.set(addressableSymbol, {
        ...owned,
        kind: "local",
        typeId: paramTypeId,
      });
      const ownedPointer = loadBindingStorageRef(owned, ctx);
      if (!ownedPointer) {
        throw new Error(
          `mutable ref call argument requires addressable temp storage (type ${paramTypeId})`,
        );
      }
      return ctx.mod.block(
        null,
        [
          ...(materialized?.setup ?? []),
          storeLocalValue({
            binding: owned,
            value: ownedValue,
            ctx,
            fnCtx,
          }),
          ownedPointer,
        ],
        owned.storageType,
      );
    }
  }
  if (abiKind === "mutable_ref") {
    const exprKind = mutablePlaceExpr?.exprKind ?? "none";
    if (
      mutablePlaceExpr &&
      ["block", "call", "method-call", "object-literal", "tuple"].includes(
        exprKind,
      )
    ) {
      const temp = allocateMutableRefLocal({
        typeId: paramTypeId,
        ctx,
        fnCtx,
      });
      const pointer = loadBindingStorageRef(temp, ctx);
      if (!pointer) {
        throw new Error(
          `mutable ref temporary requires addressable storage for ${paramTypeId}`,
        );
      }
      return ctx.mod.block(
        null,
        [
          storeLocalValue({
            binding: temp,
            value: argValue,
            ctx,
            fnCtx,
          }),
          pointer,
        ],
        temp.storageType,
      );
    }
    const location = argExpr
      ? ` at ${argExpr.span.file}:${argExpr.span.start}`
      : "";
    throw new Error(
      `mutable ref call argument requires addressable storage (type ${paramTypeId}, expr ${exprKind})${location}`,
    );
  }
  if (typeof argExprId === "number") {
    const projectedPointer = tryCompileProjectedElementStorageRefExpr({
      exprId: argExprId,
      paramTypeId,
      ctx,
      fnCtx,
      compileExpr,
    });
    if (projectedPointer) {
      return projectedPointer;
    }
  }
  const temp = allocateTempLocal(
    wasmTypeFor(paramTypeId, ctx),
    fnCtx,
    paramTypeId,
    ctx,
  );
  return ctx.mod.block(
    null,
    [
      storeLocalValue({
        binding: temp,
        value: argValue,
        ctx,
        fnCtx,
      }),
      ctx.mod.local.get(temp.index, temp.storageType),
    ],
    temp.storageType,
  );
};

export const lowerMutablePlaceArgument = ({
  exprId,
  value,
  typeId,
  writebacks,
  ctx,
  fnCtx,
  compileExpr,
}: {
  exprId: HirExprId;
  value: binaryen.ExpressionRef;
  typeId: TypeId;
  writebacks: binaryen.ExpressionRef[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): binaryen.ExpressionRef =>
  lowerCallArgumentForAbi({
    argExprId: exprId,
    argValue: value,
    paramTypeId: typeId,
    abiKind: "mutable_ref",
    ctx,
    fnCtx,
    compileExpr,
    writebacks,
  });

const resolveAddressableIdentifierSymbol = ({
  exprId,
  ctx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
}): SymbolId | undefined => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr) {
    return undefined;
  }
  if (expr.exprKind === "identifier") {
    return expr.symbol;
  }
  if (expr.exprKind !== "call" || expr.args.length !== 1) {
    return undefined;
  }
  const callee = ctx.module.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return undefined;
  }
  const calleeId = ctx.program.symbols.canonicalIdOf(
    ctx.moduleId,
    callee.symbol,
  );
  if (
    ctx.program.symbols.getIntrinsicName(calleeId) !== "~" &&
    ctx.program.symbols.getName(calleeId) !== "~"
  ) {
    return undefined;
  }
  const inner = ctx.module.hir.expressions.get(expr.args[0]!.expr);
  return inner?.exprKind === "identifier" ? inner.symbol : undefined;
};

const resolveMutablePlaceExpression = ({
  exprId,
  ctx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
}): ReturnType<CodegenContext["module"]["hir"]["expressions"]["get"]> => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (expr?.exprKind !== "call" || expr.args.length !== 1) {
    return expr;
  }
  const callee = ctx.module.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return expr;
  }
  const calleeId = ctx.program.symbols.canonicalIdOf(
    ctx.moduleId,
    callee.symbol,
  );
  if (
    ctx.program.symbols.getIntrinsicName(calleeId) !== "~" &&
    ctx.program.symbols.getName(calleeId) !== "~"
  ) {
    return expr;
  }
  return ctx.module.hir.expressions.get(expr.args[0]!.expr);
};

const NON_REF_TYPES = new Set<number>([
  binaryen.none,
  binaryen.unreachable,
  binaryen.i32,
  binaryen.i64,
  binaryen.f32,
  binaryen.f64,
]);

const resolveContainerFieldValueExprId = ({
  containerExprId,
  fieldName,
  ctx,
}: {
  containerExprId: HirExprId;
  fieldName: string;
  ctx: CodegenContext;
}): HirExprId | undefined => {
  const containerExpr = ctx.module.hir.expressions.get(containerExprId);
  if (containerExpr?.exprKind !== "object-literal") {
    return undefined;
  }
  const fieldEntry = containerExpr.entries.find(
    (entry) => entry.kind === "field" && entry.name === fieldName,
  );
  return fieldEntry?.kind === "field" ? fieldEntry.value : undefined;
};

const tryCompileContainerFieldStorageRef = ({
  containerExprId,
  containerTypeId,
  containerInfo,
  field,
  temp,
  ctx,
  fnCtx,
}: {
  containerExprId: HirExprId;
  containerTypeId: TypeId;
  containerInfo: NonNullable<ReturnType<typeof getStructuralTypeInfo>>;
  field: NonNullable<
    ReturnType<typeof getStructuralTypeInfo>
  >["fields"][number];
  temp: ReturnType<typeof allocateTempLocal>;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef | undefined => {
  const fieldStorageType = getInlineHeapBoxType({ typeId: field.typeId, ctx });
  if (
    typeof fieldStorageType !== "number" ||
    field.heapWasmType !== fieldStorageType
  ) {
    return undefined;
  }

  const containerPointer = tryLoadContainerPointer({
    containerExprId,
    containerTypeId,
    containerInfo,
    temp,
    ctx,
    fnCtx,
  });
  if (!containerPointer) {
    return undefined;
  }
  if (containerInfo.layoutKind === "value-object") {
    return undefined;
  }

  return structGetFieldValue({
    mod: ctx.mod,
    fieldIndex: field.runtimeIndex,
    fieldType: field.heapWasmType,
    exprRef: refCast(ctx.mod, containerPointer, containerInfo.runtimeType),
  });
};

const tryLoadContainerPointer = ({
  containerExprId,
  containerTypeId,
  containerInfo,
  temp,
  ctx,
  fnCtx,
}: {
  containerExprId: HirExprId;
  containerTypeId: TypeId;
  containerInfo: NonNullable<ReturnType<typeof getStructuralTypeInfo>>;
  temp: ReturnType<typeof allocateTempLocal>;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef | undefined => {
  const addressableSymbol = resolveAddressableIdentifierSymbol({
    exprId: containerExprId,
    ctx,
  });
  if (typeof addressableSymbol === "number") {
    const binding = getRequiredBinding(addressableSymbol, ctx, fnCtx);
    const storageRef = loadBindingStorageRef(binding, ctx);
    if (storageRef) {
      return storageRef;
    }
    const bindingValue = loadBindingValue(binding, ctx, fnCtx);
    const bindingValueType = binaryen.getExpressionType(bindingValue);
    if (
      binaryen.expandType(bindingValueType).length === 1 &&
      !NON_REF_TYPES.has(bindingValueType)
    ) {
      return bindingValue;
    }
  }

  const tempValue = ctx.mod.local.get(temp.index, temp.storageType);
  if (containerInfo.layoutKind === "value-object") {
    const containerStorageType = getInlineHeapBoxType({
      typeId: containerTypeId,
      ctx,
    });
    return temp.storageType === containerStorageType ? tempValue : undefined;
  }

  return tempValue;
};
