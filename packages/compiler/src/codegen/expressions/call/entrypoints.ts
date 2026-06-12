import type {
  CodegenContext,
  CompiledExpression,
  CompileCallOptions,
  ExpressionCompiler,
  FunctionContext,
  FunctionMetadata,
  HirCallExpr,
  HirExpression,
  HirMethodCallExpr,
  TypeId,
} from "../../context.js";
import type {
  ProgramFunctionInstanceId,
  ProgramSymbolId,
  SymbolId,
} from "../../../semantics/ids.js";
import { compileIntrinsicCall } from "../../intrinsics.js";
import { effectsFacade } from "../../effects/facade.js";
import { getRequiredExprType } from "../../types.js";
import {
  compileCallArgumentsWithMetadata,
} from "./arguments.js";
import { compileClosureCall, compileCurriedClosureCall } from "./closure.js";
import { getFunctionMetadataForCall } from "./metadata.js";
import { emitResolvedCall } from "./resolved-call.js";
import { compileTraitDispatchCall } from "./trait-dispatch.js";
import { compileCallArgExpressionsWithTemps } from "./shared.js";
import { getOrCreateReceiverSpecialization } from "../../receiver-specialization.js";
import { getOrCreateScalarAggregateCallSpecialization } from "../../optimization/scalar-aggregate-calls.js";

export const compileCallExpr = (
  expr: HirCallExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  options: CompileCallOptions = {}
): CompiledExpression => {
  const {
    tailPosition = false,
    expectedResultTypeId,
    outResultStorageRef,
  } = options;
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const callInstanceId = fnCtx.instanceId ?? typeInstanceId;

  const callee = ctx.module.hir.expressions.get(expr.callee);
  if (!callee) {
    throw new Error(`codegen missing callee expression ${expr.callee}`);
  }

  const callInfo = ctx.program.calls.getCallInfo(ctx.moduleId, expr.id);
  const expectTraitDispatch = callInfo.traitDispatch;

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
    const targetFunctionId = resolveTargetFunctionId({
      targets: callInfo.targets,
      callInstanceId,
      typeInstanceId,
    });
    if (typeof targetFunctionId !== "number") {
      throw new Error("codegen missing overload resolution for indirect call");
    }

    const targetRef = ctx.program.symbols.refOf(targetFunctionId as ProgramSymbolId);
    return compileResolvedSymbolCall({
      expr,
      symbol: targetRef.symbol,
      moduleId: targetRef.moduleId,
      traitDispatchEnabled: expectTraitDispatch,
      missingTraitDispatchMessage: "codegen missing trait dispatch target for indirect call",
      ctx,
      fnCtx,
      compileExpr,
      tailPosition,
      expectedResultTypeId,
      typeInstanceId,
      outResultStorageRef,
      scalarAggregateResultTypeId: options.scalarAggregateResultTypeId,
    });
  }

  const calleeTypeId = getCalleeTypeId({ expr, callee, ctx, fnCtx });
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

    const targetFunctionId = resolveTargetFunctionId({
      targets: callInfo.targets,
      callInstanceId,
      typeInstanceId,
    });

    if (typeof targetFunctionId === "number") {
      const targetRef = ctx.program.symbols.refOf(targetFunctionId as ProgramSymbolId);
      return compileResolvedSymbolCall({
        expr,
        symbol: targetRef.symbol,
        moduleId: targetRef.moduleId,
        traitDispatchEnabled: expectTraitDispatch,
        missingTraitDispatchMessage: "codegen missing trait dispatch target for call",
        ctx,
        fnCtx,
        compileExpr,
        tailPosition,
        expectedResultTypeId,
        typeInstanceId,
        outResultStorageRef,
        scalarAggregateResultTypeId: options.scalarAggregateResultTypeId,
      });
    }

    const calleeId = ctx.program.symbols.canonicalIdOf(ctx.moduleId, callee.symbol);
    const traitDispatch = expectTraitDispatch
      ? compileTraitDispatchCall({
          expr,
          calleeSymbol: callee.symbol,
          ctx,
          fnCtx,
          compileExpr,
          tailPosition,
          expectedResultTypeId,
          outResultStorageRef,
        })
      : undefined;
    if (traitDispatch) {
      return traitDispatch;
    }
    if (expectTraitDispatch) {
      throw new Error("codegen missing trait dispatch target for call");
    }

    const intrinsicMetadata = ctx.program.symbols.getIntrinsicFunctionFlags(calleeId);
    const intrinsicName =
      ctx.program.symbols.getIntrinsicName(calleeId) ??
      ctx.program.symbols.getName(calleeId) ??
      `${callee.symbol}`;
    const shouldCompileIntrinsic =
      intrinsicMetadata.intrinsic === true &&
      shouldCompileIntrinsicCall({
        intrinsicName,
        usesSignature: intrinsicMetadata.intrinsicUsesSignature,
      });

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
          name: intrinsicName,
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
      const resolvedMeta = receiverSpecializedMetaForCall({
        expr,
        meta,
        ctx,
        fnCtx,
      });
      const compiledArgs = compileCallArgumentsWithMetadata({
        call: expr,
        meta: resolvedMeta,
        ctx,
        fnCtx,
        compileExpr,
      });
      const callMeta = scalarResultSpecializedMetaForCall({
        meta: compiledArgs.meta,
        scalarAggregateResultTypeId: options.scalarAggregateResultTypeId,
        ctx,
      });
      return emitResolvedCall({
        meta: callMeta,
        args: compiledArgs.args,
        callId: expr.id,
        ctx,
        fnCtx,
        options: {
          tailPosition,
          expectedResultTypeId,
          typeInstanceId,
          outResultStorageRef,
        },
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

export const compileMethodCallExpr = (
  expr: HirMethodCallExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler,
  options: CompileCallOptions = {}
): CompiledExpression => {
  const {
    tailPosition = false,
    expectedResultTypeId,
    outResultStorageRef,
  } = options;
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const callInstanceId = fnCtx.instanceId ?? typeInstanceId;

  const callInfo = ctx.program.calls.getCallInfo(ctx.moduleId, expr.id);
  const targetFunctionId = resolveTargetFunctionId({
    targets: callInfo.targets,
    callInstanceId,
    typeInstanceId,
  });
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
        outResultStorageRef,
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
  const resolvedMeta = receiverSpecializedMetaForCall({
    expr: callView,
    meta,
    ctx,
    fnCtx,
  });

  const compiledArgs = compileCallArgumentsWithMetadata({
    call: callView,
    meta: resolvedMeta,
    ctx,
    fnCtx,
    compileExpr,
  });
  const callMeta = scalarResultSpecializedMetaForCall({
    meta: compiledArgs.meta,
    scalarAggregateResultTypeId: options.scalarAggregateResultTypeId,
    ctx,
  });
  return emitResolvedCall({
    meta: callMeta,
    args: compiledArgs.args,
    callId: expr.id,
    ctx,
    fnCtx,
    options: {
      tailPosition,
      expectedResultTypeId,
      typeInstanceId,
      outResultStorageRef,
    },
  });
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

const receiverSpecializationCallSiteKey = ({
  moduleId,
  exprId,
}: {
  moduleId: string;
  exprId: number;
}): string => `${moduleId}:${exprId}`;

const receiverSpecializationContextKey = ({
  instanceId,
  exactParameterTypes,
}: {
  instanceId: ProgramFunctionInstanceId;
  exactParameterTypes: ReadonlyMap<SymbolId, TypeId> | undefined;
}): string => {
  const serializedFacts = Array.from(exactParameterTypes?.entries() ?? [])
    .sort(([left], [right]) => left - right)
    .map(([symbol, type]) => `${symbol}=${type}`)
    .join(",");
  return `${instanceId}:${serializedFacts}`;
};

const receiverSpecializedMetaForCall = ({
  expr,
  meta,
  ctx,
  fnCtx,
}: {
  expr: HirCallExpr;
  meta: FunctionMetadata;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): FunctionMetadata => {
  if (!ctx.optimization || typeof fnCtx.instanceId !== "number") {
    return meta;
  }

  const callSiteKey = receiverSpecializationCallSiteKey({
    moduleId: ctx.moduleId,
    exprId: expr.id,
  });
  const callerContextKey = receiverSpecializationContextKey({
    instanceId: fnCtx.instanceId,
    exactParameterTypes: fnCtx.exactParameterTypes,
  });
  const exactParameterTypes = ctx.optimization.receiverSpecializationRequests
    .get(callSiteKey)
    ?.get(callerContextKey);
  if (!exactParameterTypes || exactParameterTypes.size === 0) {
    return meta;
  }

  return getOrCreateReceiverSpecialization({
    ctx,
    meta,
    exactParameterTypes,
  }) ?? meta;
};

const compileResolvedSymbolCall = ({
  expr,
  symbol,
  moduleId,
  traitDispatchEnabled,
  missingTraitDispatchMessage,
  ctx,
  fnCtx,
  compileExpr,
  tailPosition,
  expectedResultTypeId,
  typeInstanceId,
  outResultStorageRef,
  scalarAggregateResultTypeId,
}: {
  expr: HirCallExpr;
  symbol: number;
  moduleId: string;
  traitDispatchEnabled: boolean;
  missingTraitDispatchMessage: string;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  tailPosition: boolean;
  expectedResultTypeId?: TypeId;
  typeInstanceId: ProgramFunctionInstanceId | undefined;
  outResultStorageRef?: CompileCallOptions["outResultStorageRef"];
  scalarAggregateResultTypeId?: TypeId;
}): CompiledExpression => {
  const traitDispatch = traitDispatchEnabled
    ? compileTraitDispatchCall({
        expr,
        calleeSymbol: symbol,
        calleeModuleId: moduleId,
        ctx,
        fnCtx,
        compileExpr,
        tailPosition,
        expectedResultTypeId,
        outResultStorageRef,
      })
    : undefined;
  if (traitDispatch) {
    return traitDispatch;
  }
  if (traitDispatchEnabled) {
    throw new Error(missingTraitDispatchMessage);
  }

  const calleeId = ctx.program.symbols.canonicalIdOf(moduleId, symbol);
  const intrinsicMetadata = ctx.program.symbols.getIntrinsicFunctionFlags(calleeId);
  const intrinsicName =
    ctx.program.symbols.getIntrinsicName(calleeId) ??
    ctx.program.symbols.getName(calleeId) ??
    `${symbol}`;
  const shouldCompileIntrinsic =
    intrinsicMetadata.intrinsic === true &&
    shouldCompileIntrinsicCall({
      intrinsicName,
      usesSignature: intrinsicMetadata.intrinsicUsesSignature,
    });
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
        name: intrinsicName,
        call: expr,
      args,
      ctx,
      fnCtx,
      instanceId: typeInstanceId,
    }),
    usedReturnCall: false,
  };
  }

  const targetMeta = getFunctionMetadataForCall({
    symbol,
    callId: expr.id,
    ctx,
    moduleId,
    typeInstanceId,
  });
  if (!targetMeta) {
    throw new Error(`codegen cannot call symbol ${moduleId}::${symbol}`);
  }
  const resolvedMeta = receiverSpecializedMetaForCall({
    expr,
    meta: targetMeta,
    ctx,
    fnCtx,
  });

  const compiledArgs = compileCallArgumentsWithMetadata({
    call: expr,
    meta: resolvedMeta,
    ctx,
    fnCtx,
    compileExpr,
  });
  const callMeta = scalarResultSpecializedMetaForCall({
    meta: compiledArgs.meta,
    scalarAggregateResultTypeId,
    ctx,
  });
  return emitResolvedCall({
    meta: callMeta,
    args: compiledArgs.args,
    callId: expr.id,
    ctx,
    fnCtx,
    options: {
      tailPosition,
      expectedResultTypeId,
      typeInstanceId,
      outResultStorageRef,
    },
  });
};

const scalarResultSpecializedMetaForCall = ({
  meta,
  scalarAggregateResultTypeId,
  ctx,
}: {
  meta: FunctionMetadata;
  scalarAggregateResultTypeId?: TypeId;
  ctx: CodegenContext;
}): FunctionMetadata => {
  if (typeof scalarAggregateResultTypeId !== "number") {
    return meta;
  }
  return getOrCreateScalarAggregateCallSpecialization({
    ctx,
    meta,
    paramIndexes: new Set(meta.scalarAggregateParamIndexes ?? []),
    scalarResultTypeId: scalarAggregateResultTypeId,
  }) ?? meta;
};

const getCalleeTypeId = ({
  expr,
  callee,
  ctx,
  fnCtx,
}: {
  expr: HirCallExpr;
  callee: HirExpression;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): TypeId => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  if (callee.exprKind === "identifier") {
    const binding = fnCtx.bindings.get(callee.symbol);
    if (typeof binding?.typeId === "number") {
      return binding.typeId;
    }
  }

  return getRequiredExprType(expr.callee, ctx, typeInstanceId);
};

const shouldCompileIntrinsicCall = ({
  intrinsicName,
  usesSignature,
}: {
  intrinsicName: string;
  usesSignature: boolean;
}): boolean =>
  usesSignature !== true ||
  intrinsicName === "__retain_callback" ||
  intrinsicName === "__boundary_retain_callback";

const resolveTargetFunctionId = ({
  targets,
  callInstanceId,
  typeInstanceId,
}: {
  targets: ReadonlyMap<number, number> | undefined;
  callInstanceId: ProgramFunctionInstanceId | undefined;
  typeInstanceId: ProgramFunctionInstanceId | undefined;
}): number | undefined => {
  const callInstanceTarget =
    typeof callInstanceId === "number" ? targets?.get(callInstanceId) : undefined;
  if (typeof callInstanceTarget === "number") {
    return callInstanceTarget;
  }

  const typeInstanceTarget =
    typeof typeInstanceId === "number" ? targets?.get(typeInstanceId) : undefined;
  if (typeof typeInstanceTarget === "number") {
    return typeInstanceTarget;
  }

  return targets && targets.size === 1 ? targets.values().next().value : undefined;
};
