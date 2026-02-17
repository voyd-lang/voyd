import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  CompileCallOptions,
  ExpressionCompiler,
  FunctionContext,
  FunctionMetadata,
  HirCallExpr,
  HirMethodCallExpr,
  HirExprId,
  SymbolId,
  TypeId,
} from "../context.js";
import type { EffectRowId, ProgramFunctionInstanceId } from "../../semantics/ids.js";
import type { ProgramSymbolId } from "../../semantics/ids.js";
import { compileIntrinsicCall } from "../intrinsics.js";
import {
  requiresStructuralConversion,
  coerceValueToType,
  loadStructuralField,
} from "../structural.js";
import {
  getClosureTypeInfo,
  getExprBinaryenType,
  getRequiredExprType,
  getFunctionRefType,
  getStructuralTypeInfo,
  wasmTypeFor,
} from "../types.js";
import { allocateTempLocal } from "../locals.js";
import {
  callRef,
  refCast,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import { LOOKUP_METHOD_ACCESSOR, RTT_METADATA_SLOTS } from "../rtt/index.js";
import { murmurHash3 } from "@voyd/lib/murmur-hash.js";
import { effectsFacade } from "../effects/facade.js";
import { buildInstanceSubstitution } from "../type-substitution.js";
import { compileOptionalNoneValue } from "../optionals.js";
import { typeContainsUnresolvedParam } from "../../semantics/type-utils.js";
import { resolveTempCaptureTypeId } from "../effects/temp-capture-types.js";

const handlerType = (ctx: CodegenContext): binaryen.Type =>
  ctx.effectsBackend.abi.hiddenHandlerParamType(ctx);
const hiddenParamOffsetFor = (meta: FunctionMetadata): number =>
  meta.effectful
    ? Math.max(0, meta.paramTypes.length - meta.paramTypeIds.length)
    : 0;
const debugEffects = (): boolean =>
  typeof process !== "undefined" && process.env?.DEBUG_EFFECTS === "1";

const currentHandlerValue = (
  ctx: CodegenContext,
  fnCtx: FunctionContext
): binaryen.ExpressionRef => {
  if (fnCtx.currentHandler) {
    return ctx.mod.local.get(
      fnCtx.currentHandler.index,
      fnCtx.currentHandler.type
    );
  }
  return ctx.effectsBackend.abi.hiddenHandlerValue(ctx);
};

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

const getOrCreateTempLocal = ({
  tempId,
  ctx,
  fnCtx,
}: {
  tempId: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): { index: number; type: binaryen.Type } => {
  const existing = fnCtx.tempLocals.get(tempId);
  if (existing) return existing;
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const typeId =
    typeof typeInstanceId === "number"
      ? resolveTempCaptureTypeId({
          tempId,
          ctx,
          typeInstanceId,
        })
      : (ctx.effectLowering.tempTypeIds.get(tempId) ?? ctx.program.primitives.unknown);
  const wasmType = wasmTypeFor(typeId, ctx);
  const local = allocateTempLocal(wasmType, fnCtx, typeId);
  fnCtx.tempLocals.set(tempId, local);
  return local;
};

const compileCallArgExpressionsWithTemps = ({
  callId,
  args,
  argIndexOffset,
  allArgExprIds,
  expectedTypeIdAt,
  ctx,
  fnCtx,
  compileExpr,
}: {
  callId: HirExprId;
  args: readonly { expr: HirExprId }[];
  argIndexOffset?: number;
  allArgExprIds?: readonly HirExprId[];
  expectedTypeIdAt: (index: number) => TypeId | undefined;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): binaryen.ExpressionRef[] => {
  const offset = argIndexOffset ?? 0;
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const tempSpecs = ctx.effectLowering.callArgTemps.get(callId) ?? [];
  const tempsByIndex = new Map(
    tempSpecs.map((entry) => [entry.argIndex, entry.tempId] as const)
  );
  const continuationCfg = fnCtx.continuation?.cfg;
  const startedLocal = fnCtx.continuation?.startedLocal;
  const activeSiteLocal = fnCtx.continuation?.activeSiteLocal;
  const sourceArgExprIds = allArgExprIds ?? args.map((arg) => arg.expr);
  const laterSites =
    continuationCfg && startedLocal && activeSiteLocal
      ? args.map((_, index) => {
          const globalIndex = index + offset;
          const sites = new Set<number>();
          for (
            let nextIndex = globalIndex + 1;
            nextIndex < sourceArgExprIds.length;
            nextIndex += 1
          ) {
            (continuationCfg.sitesByExpr.get(sourceArgExprIds[nextIndex]!) ?? []).forEach(
              (site) => sites.add(site)
            );
          }
          return sites;
        })
      : undefined;

  return args.map((arg, index) => {
    const expectedTypeId = expectedTypeIdAt(index);
    const actualTypeId = getRequiredExprType(arg.expr, ctx, typeInstanceId);
    const tempId = tempsByIndex.get(index + offset);
    if (typeof tempId !== "number") {
      const value = compileExpr({ exprId: arg.expr, ctx, fnCtx });
      return coerceValueToType({
        value: value.expr,
        actualType: actualTypeId,
        targetType: expectedTypeId,
        ctx,
        fnCtx,
      });
    }

    const tempLocal = getOrCreateTempLocal({ tempId, ctx, fnCtx });
    const value = compileExpr({ exprId: arg.expr, ctx, fnCtx });
    const coerced = coerceValueToType({
      value: value.expr,
      actualType: actualTypeId,
      targetType: expectedTypeId,
      ctx,
      fnCtx,
    });
    const compute = ctx.mod.block(
      null,
      [
        ctx.mod.local.set(tempLocal.index, coerced),
        ctx.mod.local.get(tempLocal.index, tempLocal.type),
      ],
      tempLocal.type
    );

    if (!laterSites || !startedLocal || !activeSiteLocal) {
      return compute;
    }

    const shouldSkip = ctx.mod.i32.and(
      ctx.mod.i32.eqz(ctx.mod.local.get(startedLocal.index, binaryen.i32)),
      activeSiteInSet({
        sites: laterSites[index] ?? new Set(),
        activeSiteOrder: () =>
          ctx.mod.local.get(activeSiteLocal.index, binaryen.i32),
        ctx,
      })
    );
    return ctx.mod.if(
      shouldSkip,
      ctx.mod.local.get(tempLocal.index, tempLocal.type),
      compute
    );
  });
};

const compileCallCalleeExpressionWithTemp = ({
  call,
  ctx,
  fnCtx,
  compileExpr,
}: {
  call: HirCallExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression => {
  const calleeValue = compileExpr({ exprId: call.callee, ctx, fnCtx });
  const calleeTemp = (ctx.effectLowering.callArgTemps.get(call.id) ?? []).find(
    (entry) => entry.argIndex === -1
  );
  if (!calleeTemp) {
    return calleeValue;
  }

  const tempLocal = getOrCreateTempLocal({
    tempId: calleeTemp.tempId,
    ctx,
    fnCtx,
  });
  const compute = ctx.mod.block(
    null,
    [
      ctx.mod.local.set(tempLocal.index, calleeValue.expr),
      ctx.mod.local.get(tempLocal.index, tempLocal.type),
    ],
    tempLocal.type
  );
  const continuationCfg = fnCtx.continuation?.cfg;
  const startedLocal = fnCtx.continuation?.startedLocal;
  const activeSiteLocal = fnCtx.continuation?.activeSiteLocal;
  if (!continuationCfg || !startedLocal || !activeSiteLocal) {
    return { expr: compute, usedReturnCall: false };
  }

  const laterSites = call.args.reduce((sites, arg) => {
    (continuationCfg.sitesByExpr.get(arg.expr) ?? []).forEach((site) => sites.add(site));
    return sites;
  }, new Set<number>());
  if (laterSites.size === 0) {
    return { expr: compute, usedReturnCall: false };
  }

  const shouldSkip = ctx.mod.i32.and(
    ctx.mod.i32.eqz(ctx.mod.local.get(startedLocal.index, binaryen.i32)),
    activeSiteInSet({
      sites: laterSites,
      activeSiteOrder: () =>
        ctx.mod.local.get(activeSiteLocal.index, binaryen.i32),
      ctx,
    })
  );
  return {
    expr: ctx.mod.if(
      shouldSkip,
      ctx.mod.local.get(tempLocal.index, tempLocal.type),
      compute
    ),
    usedReturnCall: false,
  };
};

export const compileCallExpr = (
  expr: HirCallExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  options: CompileCallOptions = {}
): CompiledExpression => {
  const { tailPosition = false, expectedResultTypeId } = options;
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const callInstanceId = fnCtx.instanceId ?? typeInstanceId;
  const callee = ctx.module.hir.expressions.get(expr.callee);
  const callInfo = ctx.program.calls.getCallInfo(ctx.moduleId, expr.id);
  const expectTraitDispatch = callInfo.traitDispatch;
  if (!callee) {
    throw new Error(`codegen missing callee expression ${expr.callee}`);
  }

  if (callee.exprKind === "identifier") {
    const continuation = fnCtx.continuations?.get(callee.symbol);
    if (continuation) {
      return ctx.effectsBackend.compileContinuationCall({
        expr,
        continuation,
        ctx,
        fnCtx,
        compileExpr,
        expectedResultTypeId,
        tailPosition,
      });
    }
  }

  if (callee.exprKind === "overload-set") {
    const targets = callInfo.targets;
    const targetFunctionId =
      (typeof callInstanceId === "number" ? targets?.get(callInstanceId) : undefined) ??
      (typeof typeInstanceId === "number" ? targets?.get(typeInstanceId) : undefined) ??
      (targets && targets.size === 1
        ? targets.values().next().value
        : undefined);
    if (typeof targetFunctionId !== "number") {
      throw new Error("codegen missing overload resolution for indirect call");
    }
    const targetRef = ctx.program.symbols.refOf(targetFunctionId as ProgramSymbolId);
    const traitDispatch = expectTraitDispatch
      ? compileTraitDispatchCall({
          expr,
          calleeSymbol: targetRef.symbol,
          calleeModuleId: targetRef.moduleId,
          ctx,
          fnCtx,
          compileExpr,
          tailPosition,
          expectedResultTypeId,
        })
      : undefined;
    if (traitDispatch) {
      return traitDispatch;
    }
    if (expectTraitDispatch) {
      throw new Error(
        "codegen missing trait dispatch target for indirect call"
      );
    }
    const targetMeta = getFunctionMetadataForCall({
      symbol: targetRef.symbol,
      callId: expr.id,
      ctx,
      moduleId: targetRef.moduleId,
      typeInstanceId,
    });
    if (!targetMeta) {
      throw new Error(
        `codegen cannot call symbol ${targetRef.moduleId}::${targetRef.symbol}`
      );
    }
    const args = compileCallArguments(
      expr,
      targetMeta,
      ctx,
      fnCtx,
      compileExpr
    );
    return emitResolvedCall(targetMeta, args, expr.id, ctx, fnCtx, {
      tailPosition,
      expectedResultTypeId,
      typeInstanceId,
    });
  }

  const calleeTypeId = (() => {
    if (callee.exprKind === "identifier") {
      const binding = fnCtx.bindings.get(callee.symbol);
      if (typeof binding?.typeId === "number") {
        return binding.typeId;
      }
    }
    return getRequiredExprType(expr.callee, ctx, typeInstanceId);
  })();
  const calleeDesc = ctx.program.types.getTypeDesc(calleeTypeId);

  if (callee.exprKind === "identifier") {
    const effects = effectsFacade(ctx);
    if (effects.callKind(expr.id) === "perform") {
      return ctx.effectsBackend.compileEffectOpCall({
        expr,
        calleeSymbol: callee.symbol,
        ctx,
        fnCtx,
        compileExpr,
      });
    }
    const calleeId = ctx.program.symbols.canonicalIdOf(ctx.moduleId, callee.symbol);
    const intrinsicMetadata = ctx.program.symbols.getIntrinsicFunctionFlags(calleeId);
    const intrinsicName = ctx.program.symbols.getIntrinsicName(calleeId);

    const targets = callInfo.targets;
    const targetFunctionId =
      (typeof callInstanceId === "number" ? targets?.get(callInstanceId) : undefined) ??
      (typeof typeInstanceId === "number" ? targets?.get(typeInstanceId) : undefined) ??
      (targets && targets.size === 1 ? targets.values().next().value : undefined);
    if (typeof targetFunctionId === "number" && targetFunctionId !== calleeId) {
      const targetRef = ctx.program.symbols.refOf(targetFunctionId as ProgramSymbolId);
      const traitDispatch = expectTraitDispatch
        ? compileTraitDispatchCall({
            expr,
            calleeSymbol: targetRef.symbol,
            calleeModuleId: targetRef.moduleId,
            ctx,
            fnCtx,
            compileExpr,
            tailPosition,
            expectedResultTypeId,
          })
        : undefined;
      if (traitDispatch) {
        return traitDispatch;
      }
      if (expectTraitDispatch) {
        throw new Error("codegen missing trait dispatch target for call");
      }

      const targetMeta = getFunctionMetadataForCall({
        symbol: targetRef.symbol,
        callId: expr.id,
        ctx,
        moduleId: targetRef.moduleId,
        typeInstanceId,
      });
      if (!targetMeta) {
        throw new Error(
          `codegen cannot call symbol ${targetRef.moduleId}::${targetRef.symbol}`
        );
      }
      const args = compileCallArguments(expr, targetMeta, ctx, fnCtx, compileExpr);
      return emitResolvedCall(targetMeta, args, expr.id, ctx, fnCtx, {
        tailPosition,
        expectedResultTypeId,
        typeInstanceId,
      });
    }

    const traitDispatch = expectTraitDispatch
      ? compileTraitDispatchCall({
          expr,
          calleeSymbol: callee.symbol,
          ctx,
          fnCtx,
          compileExpr,
          tailPosition,
          expectedResultTypeId,
        })
      : undefined;
    if (traitDispatch) {
      return traitDispatch;
    }
    if (expectTraitDispatch) {
      throw new Error("codegen missing trait dispatch target for call");
    }

    const shouldCompileIntrinsic =
      intrinsicMetadata.intrinsic === true &&
      intrinsicMetadata.intrinsicUsesSignature !== true;

    if (shouldCompileIntrinsic) {
      const args = compileCallArgExpressionsWithTemps({
        callId: expr.id,
        args: expr.args,
        expectedTypeIdAt: () => undefined,
        ctx,
        fnCtx,
        compileExpr,
      });
      return {
        expr: compileIntrinsicCall({
          name:
            intrinsicName ??
            ctx.program.symbols.getName(calleeId) ??
            `${callee.symbol}`,
          call: expr,
          args,
          ctx,
          fnCtx,
          instanceId: typeInstanceId,
        }),
        usedReturnCall: false,
      };
    }

    const meta = getFunctionMetadataForCall({
      symbol: callee.symbol,
      callId: expr.id,
      ctx,
      typeInstanceId,
    });
    if (meta) {
      const args = compileCallArguments(expr, meta, ctx, fnCtx, compileExpr);
      return emitResolvedCall(meta, args, expr.id, ctx, fnCtx, {
        tailPosition,
        expectedResultTypeId,
        typeInstanceId,
      });
    }
  }

  if (calleeDesc.kind === "function") {
    if (expr.args.length > calleeDesc.parameters.length) {
      return compileCurriedClosureCall({
        expr,
        calleeTypeId,
        ctx,
        fnCtx,
        compileExpr,
        tailPosition,
        expectedResultTypeId,
      });
    }
    return compileClosureCall({
      expr,
      calleeTypeId,
      calleeDesc,
      ctx,
      fnCtx,
      compileExpr,
      tailPosition,
      expectedResultTypeId,
    });
  }

  throw new Error("codegen only supports function and closure calls today");
};

const toMethodCallView = (expr: HirMethodCallExpr): HirCallExpr => ({
  kind: "expr",
  exprKind: "call",
  id: expr.id,
  ast: expr.ast,
  span: expr.span,
  callee: expr.target,
  args: [{ expr: expr.target }, ...expr.args],
  typeArguments: expr.typeArguments,
});

export const compileMethodCallExpr = (
  expr: HirMethodCallExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  options: CompileCallOptions = {}
): CompiledExpression => {
  const { tailPosition = false, expectedResultTypeId } = options;
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const callInstanceId = fnCtx.instanceId ?? typeInstanceId;
  const callInfo = ctx.program.calls.getCallInfo(ctx.moduleId, expr.id);
  const targets = callInfo.targets;
  const targetFunctionId =
    (typeof callInstanceId === "number" ? targets?.get(callInstanceId) : undefined) ??
    (typeof typeInstanceId === "number" ? targets?.get(typeInstanceId) : undefined) ??
    (targets && targets.size === 1 ? targets.values().next().value : undefined);
  if (typeof targetFunctionId !== "number") {
    throw new Error("codegen missing method call target");
  }

  const targetRef = ctx.program.symbols.refOf(targetFunctionId as ProgramSymbolId);
  const callView = toMethodCallView(expr);
  const traitDispatch = callInfo.traitDispatch
    ? compileTraitDispatchCall({
        expr: callView,
        calleeSymbol: targetRef.symbol,
        calleeModuleId: targetRef.moduleId,
        ctx,
        fnCtx,
        compileExpr,
        tailPosition,
        expectedResultTypeId,
      })
    : undefined;
  if (traitDispatch) {
    return traitDispatch;
  }
  if (callInfo.traitDispatch) {
    throw new Error("codegen missing trait dispatch target for method call");
  }

  const meta = getFunctionMetadataForCall({
    symbol: targetRef.symbol,
    callId: expr.id,
    ctx,
    moduleId: targetRef.moduleId,
    typeInstanceId,
  });
  if (!meta) {
    throw new Error(`codegen cannot call symbol ${targetRef.moduleId}::${targetRef.symbol}`);
  }

  const args = compileCallArguments(callView, meta, ctx, fnCtx, compileExpr);
  return emitResolvedCall(meta, args, expr.id, ctx, fnCtx, {
    tailPosition,
    expectedResultTypeId,
    typeInstanceId,
  });
};

const compileTraitDispatchCall = ({
  expr,
  calleeSymbol,
  calleeModuleId,
  ctx,
  fnCtx,
  compileExpr,
  tailPosition,
  expectedResultTypeId,
}: {
  expr: HirCallExpr;
  calleeSymbol: SymbolId;
  calleeModuleId?: string;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  tailPosition: boolean;
  expectedResultTypeId?: TypeId;
}): CompiledExpression | undefined => {
  if (expr.args.length === 0) {
    return undefined;
  }
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const resolvedModuleId = calleeModuleId ?? ctx.moduleId;
  const mapping = ctx.program.traits.getTraitMethodImpl(
    ctx.program.symbols.canonicalIdOf(resolvedModuleId, calleeSymbol)
  );
  if (!mapping) {
    return undefined;
  }
  const receiverTypeId = getRequiredExprType(
    expr.args[0].expr,
    ctx,
    typeInstanceId
  );
  const receiverDesc = ctx.program.types.getTypeDesc(receiverTypeId);
  const receiverTraitSymbol =
    receiverDesc.kind === "trait" ? receiverDesc.owner : undefined;
  if (
    receiverDesc.kind !== "trait" ||
    receiverTraitSymbol !== mapping.traitSymbol
  ) {
    return undefined;
  }

  const meta = getFunctionMetadataForCall({
    symbol: calleeSymbol,
    callId: expr.id,
    ctx,
    moduleId: resolvedModuleId,
    typeInstanceId,
  });
  if (!meta) {
    return undefined;
  }

  const receiverIndex = hiddenParamOffsetFor(meta);
  const userParamTypes = meta.paramTypes.slice(receiverIndex + 1);
  const wrapperParamTypes = meta.effectful
    ? [handlerType(ctx), ctx.rtt.baseType, ...userParamTypes]
    : [ctx.rtt.baseType, ...userParamTypes];
  const fnRefType = functionRefType({
    params: wrapperParamTypes,
    result: meta.resultType,
    ctx,
  });

  const receiverValue = compileExpr({
    exprId: expr.args[0].expr,
    ctx,
    fnCtx,
  });
  const receiverTemp = allocateTempLocal(ctx.rtt.baseType, fnCtx);
  const ops: binaryen.ExpressionRef[] = [
    ctx.mod.local.set(receiverTemp.index, receiverValue.expr),
  ];
  const loadReceiver = () =>
    ctx.mod.local.get(receiverTemp.index, receiverTemp.type);
  const methodTable = structGetFieldValue({
    mod: ctx.mod,
    fieldType: ctx.rtt.methodLookupHelpers.lookupTableType,
    fieldIndex: RTT_METADATA_SLOTS.METHOD_TABLE,
    exprRef: loadReceiver(),
  });
  const accessor = ctx.mod.call(
    LOOKUP_METHOD_ACCESSOR,
    [
      ctx.mod.i32.const(
        traitMethodHash(mapping.traitSymbol, mapping.traitMethodSymbol)
      ),
      methodTable,
    ],
    binaryen.funcref
  );
  const target = refCast(ctx.mod, accessor, fnRefType);

  const args = expr.args.map((arg, index) => {
    if (index === 0) {
      return loadReceiver();
    }
    const expectedTypeId = meta.paramTypeIds[index];
    const actualTypeId = getRequiredExprType(arg.expr, ctx, typeInstanceId);
    const value = compileExpr({ exprId: arg.expr, ctx, fnCtx });
    return coerceValueToType({
      value: value.expr,
      actualType: actualTypeId,
      targetType: expectedTypeId,
      ctx,
      fnCtx,
    });
  });

  const callArgs = meta.effectful
    ? [currentHandlerValue(ctx, fnCtx), ...args]
    : args;
  const callExpr = callRef(
    ctx.mod,
    target,
    callArgs as number[],
    meta.resultType
  );
  const lowered = meta.effectful
    ? ctx.effectsBackend.lowerEffectfulCallResult({
        callExpr,
        callId: expr.id,
        returnTypeId: getRequiredExprType(expr.id, ctx, typeInstanceId),
        expectedResultTypeId,
        tailPosition,
        typeInstanceId,
        ctx,
        fnCtx,
      })
    : { expr: callExpr, usedReturnCall: false };
  ops.push(lowered.expr);
  const binaryenResult = getExprBinaryenType(expr.id, ctx, typeInstanceId);

  return {
    expr: ops.length === 1 ? ops[0]! : ctx.mod.block(null, ops, binaryenResult),
    usedReturnCall: lowered.usedReturnCall,
  };
};

const emitResolvedCall = (
  meta: FunctionMetadata,
  args: readonly binaryen.ExpressionRef[],
  callId: HirExprId,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  options: CompileCallOptions = {}
): CompiledExpression => {
  const {
    tailPosition = false,
    expectedResultTypeId,
    typeInstanceId,
  } = options;
  const lookupKey = typeInstanceId ?? meta.instanceId;
  const returnTypeId = getRequiredExprType(callId, ctx, lookupKey);
  const expectedTypeId = expectedResultTypeId ?? returnTypeId;
  const callResultWasmType = getExprBinaryenType(callId, ctx, lookupKey);
  const callerReturnWasmType =
    fnCtx.returnWasmType ?? wasmTypeFor(fnCtx.returnTypeId, ctx);
  const callArgs = meta.effectful
    ? [currentHandlerValue(ctx, fnCtx), ...args]
    : args;

  if (meta.effectful) {
    const callExpr = ctx.mod.call(
      meta.wasmName,
      callArgs as number[],
      meta.resultType
    );
    return ctx.effectsBackend.lowerEffectfulCallResult({
      callExpr,
      callId,
      returnTypeId,
      expectedResultTypeId,
      tailPosition,
      typeInstanceId,
      ctx,
      fnCtx,
    });
  }

  const allowReturnCall =
    tailPosition &&
    !fnCtx.effectful &&
    meta.resultTypeId === expectedTypeId &&
    returnTypeId === expectedTypeId &&
    meta.resultType === callerReturnWasmType &&
    callResultWasmType === callerReturnWasmType &&
    !requiresStructuralConversion(returnTypeId, expectedTypeId, ctx);

  if (allowReturnCall) {
    return {
      expr: ctx.mod.return_call(
        meta.wasmName,
        callArgs as number[],
        callResultWasmType
      ),
      usedReturnCall: true,
    };
  }

  const callExpr = ctx.mod.call(
    meta.wasmName,
    callArgs as number[],
    callResultWasmType
  );
  return {
    expr: callExpr,
    usedReturnCall: false,
  };
};

const compileCallArguments = (
  call: HirCallExpr,
  meta: FunctionMetadata,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): binaryen.ExpressionRef[] => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  return compileCallArgumentsForParams(call, meta.parameters, ctx, fnCtx, compileExpr, {
    typeInstanceId,
  });
};

type CallParam = {
  typeId: TypeId;
  label?: string;
  optional?: boolean;
  name?: string;
};

type CompileCallArgumentOptions = {
  typeInstanceId: ProgramFunctionInstanceId | undefined;
  argIndexOffset?: number;
  allowTrailingArguments?: boolean;
  allCallArgExprIds?: readonly HirExprId[];
};

type CompiledCallArgumentsForParams = {
  args: binaryen.ExpressionRef[];
  consumedArgCount: number;
};

type CallArgumentPlanEntry =
  | { kind: "direct"; argIndex: number }
  | { kind: "missing"; targetTypeId: TypeId }
  | {
      kind: "container-field";
      containerArgIndex: number;
      fieldName: string;
      targetTypeId: TypeId;
    };

type PlannedCallArguments = {
  plan: CallArgumentPlanEntry[];
  expectedTypeByArgIndex: Map<number, TypeId>;
  consumedArgCount: number;
};

const planCallArgumentsForParams = ({
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
  const calleeName = (() => {
    const callee = ctx.module.hir.expressions.get(call.callee);
    if (!callee) return "<unknown>";
    if (callee.exprKind === "identifier") {
      const calleeId = ctx.program.symbols.canonicalIdOf(ctx.moduleId, callee.symbol);
      return ctx.program.symbols.getName(calleeId) ?? `${callee.symbol}`;
    }
    if (callee.exprKind === "overload-set") {
      return callee.name;
    }
    return callee.exprKind;
  })();
  const fail = (detail: string): never => {
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
    throw new Error(
      `call argument count mismatch for ${calleeName} (call ${call.id} in ${ctx.moduleId}): ${detail}; params=[${paramSummary}]; args=[${argSummary}]`
    );
  };
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

  return { plan, expectedTypeByArgIndex, consumedArgCount: argIndex };
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

const compileCallArgumentsForParamsWithDetails = (
  call: HirCallExpr,
  params: readonly CallParam[],
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  options: CompileCallArgumentOptions
): CompiledCallArgumentsForParams => {
  const {
    typeInstanceId,
    argIndexOffset = 0,
    allowTrailingArguments = false,
    allCallArgExprIds,
  } = options;
  const planned = planCallArgumentsForParams({
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

const compileCallArgumentsForParams = (
  call: HirCallExpr,
  params: readonly CallParam[],
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  options: CompileCallArgumentOptions
): binaryen.ExpressionRef[] =>
  compileCallArgumentsForParamsWithDetails(
    call,
    params,
    ctx,
    fnCtx,
    compileExpr,
    options
  ).args;

const compileClosureArguments = (
  call: HirCallExpr,
  desc: {
    parameters: readonly { type: TypeId; label?: string; optional?: boolean }[];
  },
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): binaryen.ExpressionRef[] => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const params: CallParam[] = desc.parameters.map((param) => ({
    typeId: param.type,
    label: param.label,
    optional: param.optional,
  }));
  return compileCallArgumentsForParams(call, params, ctx, fnCtx, compileExpr, {
    typeInstanceId,
  });
};

const compileClosureCall = ({
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
  const args = compileClosureArguments(
    expr,
    resolvedDesc,
    ctx,
    fnCtx,
    compileExpr
  );
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

const compileCurriedClosureCall = ({
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
        return compileCallArgumentsForParamsWithDetails(
          remainingCall,
          params,
          ctx,
          fnCtx,
          compileExpr,
          {
            typeInstanceId,
            argIndexOffset: argIndex,
            allowTrailingArguments: true,
            allCallArgExprIds: expr.args.map((arg) => arg.expr),
          }
        );
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

const traitMethodHash = (traitSymbol: number, methodSymbol: number): number =>
  murmurHash3(`${traitSymbol}:${methodSymbol}`);

const functionRefType = ({
  params,
  result,
  ctx,
}: {
  params: readonly binaryen.Type[];
  result: binaryen.Type;
  ctx: CodegenContext;
}): binaryen.Type => {
  return getFunctionRefType({ params, result, ctx, label: "trait_method" });
};

const getFunctionMetadataForCall = ({
  symbol,
  callId,
  ctx,
  moduleId,
  typeInstanceId,
}: {
  symbol: number;
  callId: HirExprId;
  ctx: CodegenContext;
  moduleId?: string;
  typeInstanceId?: ProgramFunctionInstanceId;
}): FunctionMetadata | undefined => {
  const callInfo = ctx.program.calls.getCallInfo(ctx.moduleId, callId);
  const rawTypeArgs = (() => {
    if (typeof typeInstanceId === "number") {
      const resolved = callInfo.typeArgs?.get(typeInstanceId);
      if (resolved) {
        return resolved;
      }
    }
    const template =
      callInfo.typeArgs &&
      Array.from(callInfo.typeArgs.values()).find((args) =>
        args.some((arg) =>
          typeContainsUnresolvedParam({
            typeId: arg,
            getTypeDesc: (id) => ctx.program.types.getTypeDesc(id),
          })
        )
      );
    if (template) {
      return template;
    }
    const singleton =
      callInfo.typeArgs && callInfo.typeArgs.size === 1
        ? callInfo.typeArgs.values().next().value
        : undefined;
    if (singleton) {
      return singleton;
    }
    return [];
  })();
  const substitution = buildInstanceSubstitution({ ctx, typeInstanceId });
  const typeArgs = substitution
    ? rawTypeArgs.map((arg) => ctx.program.types.substitute(arg, substitution))
    : rawTypeArgs;

  const candidates: { moduleId: string; symbol: number }[] = [
    { moduleId: moduleId ?? ctx.moduleId, symbol },
  ];
  if (!moduleId) {
    const targetId = ctx.program.imports.getTarget(ctx.moduleId, symbol);
    if (targetId) {
      const resolved = ctx.program.symbols.refOf(targetId);
      if (
        resolved.moduleId !== ctx.moduleId ||
        resolved.symbol !== symbol
      ) {
        candidates.push({ moduleId: resolved.moduleId, symbol: resolved.symbol });
      }
    }
  }

  for (const candidate of candidates) {
    const instanceId = ctx.program.functions.getInstanceId(
      candidate.moduleId,
      candidate.symbol,
      typeArgs
    );
    const instance =
      instanceId === undefined ? undefined : ctx.functionInstances.get(instanceId);
    if (instance) {
      return instance;
    }
    const metas = ctx.functions.get(candidate.moduleId)?.get(candidate.symbol);
    if (!metas || metas.length === 0) {
      continue;
    }
    if (typeArgs.length === 0) {
      const genericMeta = metas.find((meta) => meta.typeArgs.length === 0);
      if (genericMeta) {
        return genericMeta;
      }
    }
    const exact = metas.find(
      (meta) =>
        meta.typeArgs.length === typeArgs.length &&
        meta.typeArgs.every((arg, index) => arg === typeArgs[index])
    );
    if (exact) {
      return exact;
    }
    if (typeArgs.length > 0) {
      continue;
    }
    return metas[0];
  }

  return undefined;
};

// Function metadata is stored per-module in `ctx.functions`.
