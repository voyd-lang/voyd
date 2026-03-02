import binaryen from "binaryen";
import type {
  CodegenContext,
  ExpressionCompiler,
  FunctionContext,
  FunctionMetadata,
  HirCallExpr,
  HirExprId,
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
  getRequiredExprType,
  getStructuralTypeInfo,
  wasmTypeFor,
} from "../../types.js";
import { allocateTempLocal } from "../../locals.js";
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
  ctx,
  fnCtx,
  compileExpr,
  options,
}: {
  call: HirCallExpr;
  params: readonly CallParam[];
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  options: CompileCallArgumentOptions;
}): binaryen.ExpressionRef[] =>
  compileCallArgumentsForParamsWithDetails({
    call,
    params,
    ctx,
    fnCtx,
    compileExpr,
    options,
  }).args;

export const compileCallArgumentsForParamsWithDetails = ({
  call,
  params,
  ctx,
  fnCtx,
  compileExpr,
  options,
}: {
  call: HirCallExpr;
  params: readonly CallParam[];
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
  const compiledArgs = compileCallArgExpressionsWithTemps({
    callId: call.id,
    args: consumedArgs,
    argIndexOffset,
    allArgExprIds: allCallArgExprIds ?? call.args.map((arg) => arg.expr),
    expectedTypeIdAt: (index) => planned.expectedTypeByArgIndex.get(index),
    ctx,
    fnCtx,
    compileExpr,
  });

  const args = materializeCallArgumentPlan({
    plan: planned.plan,
    compiledArgs,
    callArgs: call.args,
    typeInstanceId,
    ctx,
    fnCtx,
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
  typeInstanceId,
  ctx,
  fnCtx,
}: {
  plan: readonly CallArgumentPlanEntry[];
  compiledArgs: readonly binaryen.ExpressionRef[];
  callArgs: readonly HirCallExpr["args"][number][];
  typeInstanceId: ProgramFunctionInstanceId | undefined;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef[] => {
  const containerTemps = new Map<number, ReturnType<typeof allocateTempLocal>>();
  const initializedContainers = new Set<number>();

  return plan.map((entry) => {
    if (entry.kind === "direct") {
      return compiledArgs[entry.argIndex]!;
    }

    if (entry.kind === "missing") {
      return compileOptionalNoneValue({
        targetTypeId: entry.targetTypeId,
        ctx,
        fnCtx,
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
        const created = allocateTempLocal(containerInfo.interfaceType, fnCtx);
        containerTemps.set(entry.containerArgIndex, created);
        return created;
      })();

    const pointer = () =>
      ctx.mod.local.get(temp.index, containerInfo.interfaceType);
    const loaded = loadStructuralField({
      structInfo: containerInfo,
      field,
      pointer: pointer(),
      ctx,
    });
    const coerced = coerceValueToType({
      value: loaded,
      actualType: field.typeId,
      targetType: entry.targetTypeId,
      ctx,
      fnCtx,
    });

    if (initializedContainers.has(entry.containerArgIndex)) {
      return coerced;
    }

    initializedContainers.add(entry.containerArgIndex);
    return ctx.mod.block(
      null,
      [
        ctx.mod.local.set(temp.index, compiledArgs[entry.containerArgIndex]!),
        coerced,
      ],
      wasmTypeFor(entry.targetTypeId, ctx)
    );
  });
};
