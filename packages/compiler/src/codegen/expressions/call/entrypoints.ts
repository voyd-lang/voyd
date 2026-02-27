import type {
  CodegenContext,
  CompiledExpression,
  CompileCallOptions,
  ExpressionCompiler,
  FunctionContext,
  HirCallExpr,
  HirExpression,
  HirMethodCallExpr,
  TypeId,
} from "../../context.js";
import type {
  ProgramFunctionInstanceId,
  ProgramSymbolId,
} from "../../../semantics/ids.js";
import { compileIntrinsicCall } from "../../intrinsics.js";
import { effectsFacade } from "../../effects/facade.js";
import { getRequiredExprType } from "../../types.js";
import { compileCallArguments } from "./arguments.js";
import { compileClosureCall, compileCurriedClosureCall } from "./closure.js";
import { getFunctionMetadataForCall } from "./metadata.js";
import { emitResolvedCall } from "./resolved-call.js";
import { compileTraitDispatchCall } from "./trait-dispatch.js";
import { compileCallArgExpressionsWithTemps } from "./shared.js";

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

    const calleeId = ctx.program.symbols.canonicalIdOf(ctx.moduleId, callee.symbol);
    const targetFunctionId = resolveTargetFunctionId({
      targets: callInfo.targets,
      callInstanceId,
      typeInstanceId,
    });

    if (typeof targetFunctionId === "number" && targetFunctionId !== calleeId) {
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

    const intrinsicMetadata = ctx.program.symbols.getIntrinsicFunctionFlags(calleeId);
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
            ctx.program.symbols.getIntrinsicName(calleeId) ??
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
      const args = compileCallArguments({
        call: expr,
        meta,
        ctx,
        fnCtx,
        compileExpr,
      });
      return emitResolvedCall({
        meta,
        args,
        callId: expr.id,
        ctx,
        fnCtx,
        options: {
          tailPosition,
          expectedResultTypeId,
          typeInstanceId,
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
  const { tailPosition = false, expectedResultTypeId } = options;
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

  const args = compileCallArguments({
    call: callView,
    meta,
    ctx,
    fnCtx,
    compileExpr,
  });
  return emitResolvedCall({
    meta,
    args,
    callId: expr.id,
    ctx,
    fnCtx,
    options: {
      tailPosition,
      expectedResultTypeId,
      typeInstanceId,
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
      })
    : undefined;
  if (traitDispatch) {
    return traitDispatch;
  }
  if (traitDispatchEnabled) {
    throw new Error(missingTraitDispatchMessage);
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

  const args = compileCallArguments({
    call: expr,
    meta: targetMeta,
    ctx,
    fnCtx,
    compileExpr,
  });
  return emitResolvedCall({
    meta: targetMeta,
    args,
    callId: expr.id,
    ctx,
    fnCtx,
    options: {
      tailPosition,
      expectedResultTypeId,
      typeInstanceId,
    },
  });
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
