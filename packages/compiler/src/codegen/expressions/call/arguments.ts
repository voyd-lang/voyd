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
  SymbolId,
  TypeId,
} from "../../context.js";
import type { ProgramFunctionInstanceId } from "../../../semantics/ids.js";
import type { CallArgumentPlanEntry } from "../../../semantics/typing/types.js";
import { compileOptionalNoneValue } from "../../optionals.js";
import {
  coerceValueToType,
  loadStructuralField,
} from "../../structural.js";
import {
  getInlineHeapBoxType,
  getRequiredExprType,
  getStructuralTypeInfo,
  wasmTypeFor,
} from "../../types.js";
import {
  allocateAddressableLocal,
  allocateTempLocal,
  getRequiredBinding,
  loadLocalValue,
  loadBindingValue,
  loadBindingStorageRef,
  storeLocalValue,
} from "../../locals.js";
import {
  materializeProjectedElementBinding,
  tryCompileProjectedElementStorageRefExpr,
} from "../../projected-element-views.js";
import { compileCallArgExpressionsWithTemps } from "./shared.js";
import type {
  CallParam,
  CompileCallArgumentOptions,
  CompiledCallArgumentsForParams,
  PlannedCallArguments,
} from "./types.js";

export const compileCallArguments = ({
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
}): binaryen.ExpressionRef[] => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const typedPlan = resolveTypedCallArgumentPlan({
    callId: call.id,
    typeInstanceId,
    ctx,
  });

  return compileCallArgumentsForParams({
    call,
    params: meta.parameters,
    paramAbiKinds: meta.paramAbiKinds,
    ctx,
    fnCtx,
    compileExpr,
    options: {
      typeInstanceId,
      typedPlan,
    },
  });
};

export const compileCallArgumentsForParams = ({
  call,
  params,
  paramAbiKinds,
  ctx,
  fnCtx,
  compileExpr,
  options,
}: {
  call: HirCallExpr;
  params: readonly CallParam[];
  paramAbiKinds?: readonly string[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  options: CompileCallArgumentOptions;
}): binaryen.ExpressionRef[] =>
  compileCallArgumentsForParamsWithDetails({
    call,
    params,
    paramAbiKinds,
    ctx,
    fnCtx,
    compileExpr,
    options,
  }).args;

export const compileCallArgumentsForParamsWithDetails = ({
  call,
  params,
  paramAbiKinds,
  ctx,
  fnCtx,
  compileExpr,
  options,
}: {
  call: HirCallExpr;
  params: readonly CallParam[];
  paramAbiKinds?: readonly string[];
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

  const consumedArgs = call.args.slice(0, planned.consumedArgCount);
  const preservedArgIndexes = collectPreservedStorageRefArgIndexes({
    plan: planned.plan,
    paramAbiKinds,
  });
  const compiledArgs = compileCallArgExpressionsWithTemps({
    callId: call.id,
    args: consumedArgs,
    argIndexOffset,
    allArgExprIds: allCallArgExprIds ?? call.args.map((arg) => arg.expr),
    expectedTypeIdAt: (index) => planned.expectedTypeByArgIndex.get(index),
    preserveStorageRefsAt: (index) => preservedArgIndexes.has(index + argIndexOffset),
    ctx,
    fnCtx,
    compileExpr,
  });

  const args = materializeCallArgumentPlan({
    plan: planned.plan,
    compiledArgs,
    callArgs: call.args,
    paramTypeIds: params.map((param) => param.typeId),
    paramAbiKinds,
    typeInstanceId,
    ctx,
    fnCtx,
    compileExpr,
  });

  return { args, consumedArgCount: planned.consumedArgCount };
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
          `typed call argument plan direct index ${entry.argIndex} is before slice offset ${argOffset}`
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
          `typed call argument plan container index ${entry.containerArgIndex} is before slice offset ${argOffset}`
        );
      }
      return {
        kind: "container-field",
        containerArgIndex: entry.containerArgIndex - argOffset,
        fieldName: entry.fieldName,
        targetTypeId: entry.targetTypeId,
      };
    }

    return {
      kind: "missing",
      targetTypeId: entry.targetTypeId,
    };
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
        `${index}:${param.label ?? "_"}${param.optional ? "?" : ""}@${param.typeId}`
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
      `call argument count mismatch for ${calleeName} (call ${call.id} in ${ctx.moduleId}): ${detail}; params=[${paramSummary}]; args=[${argSummary}]`
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
    const calleeId = ctx.program.symbols.canonicalIdOf(ctx.moduleId, callee.symbol);
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

  const labelsCompatible = (param: CallParam, argLabel: string | undefined): boolean => {
    if (!param.label) {
      return argLabel === undefined;
    }
    return argLabel === param.label;
  };

  const allowsOmittedArgument = (param: CallParam): boolean =>
    param.optional === true ||
    ctx.program.optionals.getOptionalInfo(ctx.moduleId, param.typeId) !== undefined;

  const plan: CallArgumentPlanEntry[] = [];
  const expectedTypeByArgIndex = new Map<number, TypeId>();
  let argIndex = 0;
  let paramIndex = 0;

  while (paramIndex < params.length) {
    const param = params[paramIndex]!;
    const arg = call.args[argIndex];

    if (!arg) {
      if (allowsOmittedArgument(param)) {
        plan.push({ kind: "missing", targetTypeId: param.typeId });
        paramIndex += 1;
        continue;
      }
      fail("missing required argument");
    }

    if (param.label && arg.label === undefined) {
      const containerTypeId = getRequiredExprType(arg.expr, ctx, typeInstanceId);
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
            plan.push({ kind: "missing", targetTypeId: runParam.typeId });
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
      plan.push({ kind: "missing", targetTypeId: param.typeId });
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
    fail(`typed plan length mismatch (expected ${params.length}, got ${typedPlan.length})`);
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

    if (entry.kind === "missing") {
      plan.push({
        kind: "missing",
        targetTypeId: currentParam.typeId,
      });
      return;
    }

    if (entry.containerArgIndex < 0 || entry.containerArgIndex >= call.args.length) {
      fail(
        `typed plan container arg index ${entry.containerArgIndex} is out of range`
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
  typeInstanceId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  plan: readonly CallArgumentPlanEntry[];
  compiledArgs: readonly binaryen.ExpressionRef[];
  callArgs: readonly HirCallExpr["args"][number][];
  paramTypeIds: readonly TypeId[];
  paramAbiKinds?: readonly string[];
  typeInstanceId: ProgramFunctionInstanceId | undefined;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): binaryen.ExpressionRef[] => {
  const containerTemps = new Map<number, ReturnType<typeof allocateTempLocal>>();
  const initializedContainers = new Set<number>();
  const mutableRefContainerArgs = new Set(
    plan.flatMap((entry, index) =>
      entry.kind === "container-field" && paramAbiKinds?.[index] === "mutable_ref"
        ? [entry.containerArgIndex]
        : [],
    ),
  );

  return plan.map((entry, paramIndex) => {
    const abiKind = paramAbiKinds?.[paramIndex];
    const paramTypeId = paramTypeIds[paramIndex];
    if (entry.kind === "direct") {
      return lowerCallArgumentForAbi({
        argExprId: callArgs[entry.argIndex]?.expr,
        argValue: compiledArgs[entry.argIndex]!,
        paramTypeId,
        abiKind,
        ctx,
        fnCtx,
        compileExpr,
      });
    }

    if (entry.kind === "missing") {
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
      });
    }

    const containerArg = callArgs[entry.containerArgIndex]!;
    const containerTypeId = getRequiredExprType(
      containerArg.expr,
      ctx,
      typeInstanceId
    );
    const containerInfo = getStructuralTypeInfo(containerTypeId, ctx);
    if (!containerInfo) {
      throw new Error("labeled-argument container requires a structural value");
    }

    const field = containerInfo.fieldMap.get(entry.fieldName);
    if (!field) {
      throw new Error(`missing field ${entry.fieldName} in labeled-argument container`);
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
    const initOps =
      initializedContainers.has(entry.containerArgIndex)
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

    const loaded = loadStructuralField({
      structInfo: containerInfo,
      field,
      pointer: () => loadLocalValue(temp, ctx),
      ctx,
    });
    const coerced = coerceValueToType({
      value: loaded,
      actualType: field.typeId,
      targetType: entry.targetTypeId,
      ctx,
      fnCtx,
    });
    const fieldExprId = resolveContainerFieldValueExprId({
      containerExprId: containerArg.expr,
      fieldName: entry.fieldName,
      ctx,
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

    if (
      abiKind === "mutable_ref" &&
      typeof paramTypeId === "number" &&
      typeof fieldExprId === "number" &&
      typeof resolveAddressableIdentifierSymbol({ exprId: fieldExprId, ctx }) !== "number" &&
      !containerFieldStorageRef
    ) {
      const fieldTemp = allocateAddressableLocal({
        typeId: paramTypeId,
        ctx,
        fnCtx,
      });
      const fieldPointer = loadBindingStorageRef(fieldTemp, ctx);
      if (!fieldPointer) {
        throw new Error(
          `mutable ref labeled argument requires addressable temp storage (type ${paramTypeId})`,
        );
      }
      return ctx.mod.block(
        null,
        [
          ...initOps,
          storeLocalValue({
            binding: fieldTemp,
            value: coerced,
            ctx,
            fnCtx,
          }),
          fieldPointer,
        ],
        fieldTemp.storageType,
      );
    }

    const result = lowerCallArgumentForAbi({
      argExprId: fieldExprId,
      argValue: coerced,
      addressableValue: containerFieldStorageRef,
      paramTypeId,
      abiKind,
      ctx,
      fnCtx,
      compileExpr,
    });
    if (initOps.length === 0) {
      return result;
    }
    return ctx.mod.block(
      null,
      [...initOps, result],
      binaryen.getExpressionType(result)
    );
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
    usage.set(entry.argIndex, existing === undefined ? preserves : existing && preserves);
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
  ctx,
  fnCtx,
  compileExpr,
}: {
  argExprId?: HirExprId;
  argValue: binaryen.ExpressionRef;
  addressableValue?: binaryen.ExpressionRef;
  paramTypeId?: TypeId;
  abiKind?: string;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): binaryen.ExpressionRef => {
  if (abiKind !== "readonly_ref" && abiKind !== "mutable_ref") {
    return argValue;
  }
  if (typeof paramTypeId !== "number") {
    throw new Error("ref ABI argument lowering requires a concrete parameter type");
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
      const materialized =
        existing.kind === "projected-element-ref"
          ? materializeProjectedElementBinding({
              symbol: addressableSymbol,
              binding: existing,
              ctx,
              fnCtx,
            })
          : undefined;
      const ownedValue = materialized
        ? loadBindingValue(materialized.binding, ctx)
        : argValue;
      const owned = allocateAddressableLocal({
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
    const exprKind =
      typeof argExprId === "number"
        ? ctx.module.hir.expressions.get(argExprId)?.exprKind ?? "missing"
        : "none";
    throw new Error(
      `mutable ref call argument requires addressable storage (type ${paramTypeId}, expr ${exprKind})`,
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
  const calleeId = ctx.program.symbols.canonicalIdOf(ctx.moduleId, callee.symbol);
  if (
    ctx.program.symbols.getIntrinsicName(calleeId) !== "~" &&
    ctx.program.symbols.getName(calleeId) !== "~"
  ) {
    return undefined;
  }
  const inner = ctx.module.hir.expressions.get(expr.args[0]!.expr);
  return inner?.exprKind === "identifier" ? inner.symbol : undefined;
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
  field: NonNullable<ReturnType<typeof getStructuralTypeInfo>>["fields"][number];
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
    const bindingValue = loadBindingValue(binding, ctx);
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
