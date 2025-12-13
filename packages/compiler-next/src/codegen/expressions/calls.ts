import binaryen from "binaryen";
import type { AugmentedBinaryen } from "@voyd/lib/binaryen-gc/types.js";
import type {
  CodegenContext,
  CompiledExpression,
  CompileCallOptions,
  ExpressionCompiler,
  FunctionContext,
  FunctionMetadata,
  HirCallExpr,
  HirExprId,
  ContinuationBinding,
  SymbolId,
  TypeId,
} from "../context.js";
import type {
  ContinuationCallSite,
  ContinuationPerformSite,
  ContinuationSite,
} from "../effects/effect-lowering.js";
import type { HirFunction, HirPattern } from "../../semantics/hir/index.js";
import type { EffectRowId, HirStmtId } from "../../semantics/ids.js";
import { compileIntrinsicCall } from "../intrinsics.js";
import {
  requiresStructuralConversion,
  coerceValueToType,
} from "../structural.js";
import {
  getClosureTypeInfo,
  getExprBinaryenType,
  getRequiredExprType,
  wasmTypeFor,
} from "../types.js";
import {
  allocateTempLocal,
  getRequiredBinding,
  loadBindingValue,
} from "../locals.js";
import {
  callRef,
  initStruct,
  refCast,
  refFunc,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import { LOOKUP_METHOD_ACCESSOR, RTT_METADATA_SLOTS } from "../rtt/index.js";
import { murmurHash3 } from "@voyd/lib/murmur-hash.js";
import { OUTCOME_TAGS } from "../effects/runtime-abi.js";
import { unboxOutcomeValue } from "../effects/outcome-values.js";
import { wrapValueInOutcome } from "../effects/outcome-values.js";
import { handlerCleanupOps } from "../effects/handler-stack.js";
import { ensureDispatcher } from "../effects/dispatcher.js";
import { createGroupedContinuationExpressionCompiler } from "../effects/continuation-compiler.js";
import { buildGroupContinuationCfg } from "../effects/continuation-cfg.js";
import { wrapRequestContinuationWithFrame } from "../effects/continuation-bind.js";
import { boxOutcomeValue } from "../effects/outcome-values.js";

const bin = binaryen as unknown as AugmentedBinaryen;
let traitDispatchSigCounter = 0;

const handlerType = (ctx: CodegenContext): binaryen.Type =>
  ctx.effectsRuntime.handlerFrameType;

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
  return ctx.mod.ref.null(handlerType(ctx));
};

const findFunctionBySymbol = (
  symbol: SymbolId,
  ctx: CodegenContext
): { fn: HirFunction; returnTypeId: TypeId } => {
  for (const item of ctx.hir.items.values()) {
    if (item.kind === "function" && item.symbol === symbol) {
      const signature = ctx.typing.functions.getSignature(symbol);
      if (!signature) {
        throw new Error("missing signature for continuation function");
      }
      return { fn: item, returnTypeId: signature.returnType };
    }
  }
  throw new Error(`could not find function for symbol ${symbol}`);
};

const collectLocalSymbols = (
  fn: HirFunction,
  ctx: CodegenContext
): Set<SymbolId> => {
  const symbols = new Set<SymbolId>();
  const visitPattern = (pattern: HirPattern): void => {
    switch (pattern.kind) {
      case "identifier":
        symbols.add(pattern.symbol);
        return;
      case "destructure":
        pattern.fields.forEach((field) => visitPattern(field.pattern));
        if (pattern.spread) visitPattern(pattern.spread);
        return;
      case "tuple":
        pattern.elements.forEach((element) => visitPattern(element));
        return;
      case "type":
        if (pattern.binding) visitPattern(pattern.binding);
        return;
      case "wildcard":
        return;
    }
  };

  fn.parameters.forEach((param) => visitPattern(param.pattern));

  const visitExpr = (exprId: HirExprId): void => {
    const expr = ctx.hir.expressions.get(exprId);
    if (!expr) return;
    switch (expr.exprKind) {
      case "block":
        expr.statements.forEach((stmtId) => visitStmt(stmtId));
        if (typeof expr.value === "number") visitExpr(expr.value);
        return;
      case "call":
        visitExpr(expr.callee);
        expr.args.forEach((arg) => visitExpr(arg.expr));
        return;
      case "tuple":
        expr.elements.forEach((element) => visitExpr(element));
        return;
      case "loop":
      case "while":
        visitExpr(expr.body);
        if (expr.exprKind === "while") {
          visitExpr(expr.condition);
        }
        return;
      case "if":
      case "cond":
        expr.branches.forEach((branch) => {
          visitExpr(branch.condition);
          visitExpr(branch.value);
        });
        if (typeof expr.defaultBranch === "number") {
          visitExpr(expr.defaultBranch);
        }
        return;
      case "match":
        visitExpr(expr.discriminant);
        expr.arms.forEach((arm) => {
          if (typeof arm.guard === "number") visitExpr(arm.guard);
          visitExpr(arm.value);
        });
        return;
      case "object-literal":
        expr.entries.forEach((entry) => visitExpr(entry.value));
        return;
      case "field-access":
        visitExpr(expr.target);
        return;
      case "assign":
        if (typeof expr.target === "number") visitExpr(expr.target);
        visitExpr(expr.value);
        if (expr.pattern) visitPattern(expr.pattern);
        return;
      case "effect-handler":
        visitExpr(expr.body);
        if (typeof expr.finallyBranch === "number") {
          visitExpr(expr.finallyBranch);
        }
        return;
      case "identifier":
      case "literal":
      case "lambda":
      case "overload-set":
      case "continue":
      case "break":
        return;
    }
  };

  const visitStmt = (stmtId: HirStmtId): void => {
    const stmt = ctx.hir.statements.get(stmtId);
    if (!stmt) return;
    switch (stmt.kind) {
      case "let":
        visitPattern(stmt.pattern);
        visitExpr(stmt.initializer);
        return;
      case "expr-stmt":
        visitExpr(stmt.expr);
        return;
      case "return":
        if (typeof stmt.value === "number") visitExpr(stmt.value);
        return;
    }
  };

  visitExpr(fn.body);
  return symbols;
};

const ensureContinuationFunction = ({
  site,
  ctx,
}: {
  site: ContinuationSite;
  ctx: CodegenContext;
}): binaryen.Type => {
  const built = ctx.effectsState.contBuilt;
  const building = ctx.effectsState.contBuilding;
  const contName = site.contFnName;
  const resumeBoxType = binaryen.eqref;
  const provisionalRefType = functionRefType({
    params: [binaryen.anyref, resumeBoxType],
    result: ctx.effectsRuntime.outcomeType,
    ctx,
  });
  if (built.has(contName)) {
    return site.contRefType ?? provisionalRefType;
  }
  if (building.has(contName)) {
    site.contRefType ??= provisionalRefType;
    return site.contRefType;
  }
  building.add(contName);

  const { fn, returnTypeId } = findFunctionBySymbol(site.functionSymbol, ctx);
  const params = [binaryen.anyref, resumeBoxType];
  const returnWasmType = wasmTypeFor(returnTypeId, ctx);

  const groupSites = ctx.effectLowering.sites.filter(
    (candidate) =>
      candidate.functionSymbol === site.functionSymbol &&
      candidate.contFnName === contName
  );

  const locals: binaryen.Type[] = [];
  const fnCtx: FunctionContext = {
    bindings: new Map(),
    locals,
    nextLocalIndex: params.length,
    returnTypeId,
    instanceKey: undefined,
    typeInstanceKey: undefined,
    effectful: true,
  };

  const localsToSeed = collectLocalSymbols(fn, ctx);
  localsToSeed.forEach((symbol) => {
    const typeId =
      ctx.typing.valueTypes.get(symbol) ?? ctx.typing.primitives.unknown;
    const wasmType = wasmTypeFor(typeId, ctx);
    const seeded = allocateTempLocal(wasmType, fnCtx, typeId);
    fnCtx.bindings.set(symbol, {
      ...seeded,
      kind: "local",
      typeId,
    });
  });

  const handlerLocal = allocateTempLocal(
    ctx.effectsRuntime.handlerFrameType,
    fnCtx
  );
  fnCtx.currentHandler = { index: handlerLocal.index, type: handlerLocal.type };

  const startedLocal = allocateTempLocal(
    binaryen.i32,
    fnCtx,
    ctx.typing.primitives.i32
  );
  const activeSiteLocal = allocateTempLocal(
    binaryen.i32,
    fnCtx,
    ctx.typing.primitives.i32
  );

  const envParamIndex = 0;
  const baseEnvRef = () =>
    refCast(
      ctx.mod,
      ctx.mod.local.get(envParamIndex, binaryen.anyref),
      site.baseEnvType
    );
  const activeSiteFromEnv = structGetFieldValue({
    mod: ctx.mod,
    fieldIndex: 0,
    fieldType: binaryen.i32,
    exprRef: baseEnvRef(),
  });
  const initActiveSite = ctx.mod.local.set(
    activeSiteLocal.index,
    activeSiteFromEnv
  );
  const initStarted = ctx.mod.local.set(
    startedLocal.index,
    ctx.mod.i32.const(0)
  );

  const cfgCache = ctx.effectsState.contCfgByName;
  const cfg =
    cfgCache.get(contName) ??
    (() => {
      const builtCfg = buildGroupContinuationCfg({
        fn,
        groupSites,
        ctx,
      });
      cfgCache.set(contName, builtCfg);
      return builtCfg;
    })();

  const resumeLocal =
    ({
      kind: "local",
      index: 1,
      type: resumeBoxType,
      typeId: ctx.typing.primitives.unknown,
    } as const);

  const continuationCompiler = createGroupedContinuationExpressionCompiler({
    cfg,
    activeSiteOrder: () =>
      ctx.mod.local.get(activeSiteLocal.index, binaryen.i32),
    startedLocal,
    resumeLocal,
  });

  const bodyExpr = continuationCompiler({
    exprId: fn.body,
    ctx,
    fnCtx,
    tailPosition: true,
    expectedResultTypeId: returnTypeId,
  });
  const needsWrap =
    binaryen.getExpressionType(bodyExpr.expr) === returnWasmType;
  const bodyOutcomeExpr = needsWrap
    ? wrapValueInOutcome({
        valueExpr: bodyExpr.expr,
        valueType: returnWasmType,
        ctx,
      })
    : bodyExpr.expr;

  let restoreChain = ctx.mod.nop();

  [...groupSites].reverse().forEach((groupSite) => {
    const envLocalGetter = () =>
      refCast(
        ctx.mod,
        ctx.mod.local.get(envParamIndex, binaryen.anyref),
        groupSite.envType
      );
    const initOps: binaryen.ExpressionRef[] = [];
    groupSite.envFields.forEach((field, fieldIndex) => {
      if (field.sourceKind === "site") return;
      const value = structGetFieldValue({
        mod: ctx.mod,
        fieldIndex,
        fieldType: field.wasmType,
        exprRef: envLocalGetter(),
      });
      if (field.sourceKind === "handler") {
        initOps.push(ctx.mod.local.set(handlerLocal.index, value));
        return;
      }
      if (typeof field.symbol !== "number") {
        throw new Error("missing symbol for env field");
      }
      const binding = fnCtx.bindings.get(field.symbol);
      if (!binding || binding.kind !== "local") {
        throw new Error("missing local binding for env restore");
      }
      initOps.push(ctx.mod.local.set(binding.index, value));
    });
    const restoreBlock =
      initOps.length === 0
        ? ctx.mod.nop()
        : ctx.mod.block(null, initOps, binaryen.none);
    const matches = ctx.mod.i32.eq(
      ctx.mod.local.get(activeSiteLocal.index, binaryen.i32),
      ctx.mod.i32.const(groupSite.siteOrder)
    );
    restoreChain = ctx.mod.if(matches, restoreBlock, restoreChain);
  });

  const activeSiteGet = () =>
    ctx.mod.local.get(activeSiteLocal.index, binaryen.i32);
  const matchAny = groupSites
    .map((groupSite) =>
      ctx.mod.i32.eq(activeSiteGet(), ctx.mod.i32.const(groupSite.siteOrder))
    )
    .reduce(
      (acc, exprRef) => ctx.mod.i32.or(acc, exprRef),
      ctx.mod.i32.const(0)
    );

  const fnRef = ctx.mod.addFunction(
    contName,
    binaryen.createType(params),
    ctx.effectsRuntime.outcomeType,
    locals,
    ctx.mod.block(
      null,
      [
        initActiveSite,
        initStarted,
        restoreChain,
        ctx.mod.if(
          matchAny,
          bodyOutcomeExpr,
          ctx.mod.ref.null(ctx.effectsRuntime.outcomeType)
        ),
      ],
      ctx.effectsRuntime.outcomeType
    )
  );

  const fnHeapType = bin._BinaryenFunctionGetType(fnRef);
  const contRefType = bin._BinaryenTypeFromHeapType(fnHeapType, false);
  groupSites.forEach((groupSite) => {
    groupSite.contRefType = contRefType;
  });
  building.delete(contName);
  built.add(contName);
  return contRefType;
};

const lowerEffectfulCallResult = ({
  callExpr,
  callId,
  returnTypeId,
  expectedResultTypeId,
  tailPosition,
  typeInstanceKey,
  ctx,
  fnCtx,
}: {
  callExpr: binaryen.ExpressionRef;
  callId: HirExprId;
  returnTypeId: TypeId;
  expectedResultTypeId?: TypeId;
  tailPosition: boolean;
  typeInstanceKey?: string;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): CompiledExpression => {
  const lookupKey =
    typeInstanceKey ?? fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  const valueType = wasmTypeFor(returnTypeId, ctx);
  const outcomeTemp = allocateTempLocal(ctx.effectsRuntime.outcomeType, fnCtx);
  const ops: binaryen.ExpressionRef[] = [
    ctx.mod.local.set(outcomeTemp.index, callExpr),
  ];
  const loadOutcome = () =>
    ctx.mod.local.get(outcomeTemp.index, ctx.effectsRuntime.outcomeType);
  const maybeDispatchEffect = ctx.mod.i32.eq(
    ctx.effectsRuntime.outcomeTag(loadOutcome()),
    ctx.mod.i32.const(OUTCOME_TAGS.effect)
  );
  ops.push(
    ctx.mod.if(
      maybeDispatchEffect,
      ctx.mod.local.set(
        outcomeTemp.index,
        ctx.mod.call(
          ensureDispatcher(ctx),
          [loadOutcome()],
          ctx.effectsRuntime.outcomeType
        )
      ),
      ctx.mod.nop()
    )
  );
  const tagIsValue = ctx.mod.i32.eq(
    ctx.effectsRuntime.outcomeTag(loadOutcome()),
    ctx.mod.i32.const(OUTCOME_TAGS.value)
  );
  const payload = ctx.effectsRuntime.outcomePayload(loadOutcome());
  const unboxed = unboxOutcomeValue({
    payload,
    valueType,
    ctx,
  });
  const valueResult = unboxed;
  const effectReturn = fnCtx.effectful
    ? (() => {
        const cleanup = handlerCleanupOps({ ctx, fnCtx });
        const site = !tailPosition ? ctx.effectLowering.sitesByExpr.get(callId) : undefined;
        const shouldWrap = !!site && site.kind === "call" && !tailPosition;

        if (!shouldWrap) {
          const ret = ctx.mod.return(loadOutcome());
          if (cleanup.length === 0) return ret;
          return ctx.mod.block(null, [...cleanup, ret], binaryen.none);
        }

        const callSite = site as ContinuationCallSite;
        const frameEnvValues = callSite.envFields.map((field) => {
          switch (field.sourceKind) {
            case "site":
              return ctx.mod.i32.const(callSite.siteOrder);
            case "handler":
              return currentHandlerValue(ctx, fnCtx);
            case "param":
            case "local": {
              if (typeof field.symbol !== "number") {
                throw new Error("missing symbol for env field");
              }
              const binding = getRequiredBinding(field.symbol, ctx, fnCtx);
              return loadBindingValue(binding, ctx);
            }
          }
        });

        const contRefType = ensureContinuationFunction({ site: callSite, ctx });
        const frameEnv = initStruct(ctx.mod, callSite.envType, frameEnvValues as number[]);
        const frameCont = ctx.effectsRuntime.makeContinuation({
          fnRef: refFunc(ctx.mod, callSite.contFnName, contRefType),
          env: frameEnv,
          site: ctx.mod.i32.const(callSite.siteOrder),
        });

        const request = refCast(
          ctx.mod,
          ctx.effectsRuntime.outcomePayload(loadOutcome()),
          ctx.effectsRuntime.effectRequestType
        );
        const wrappedRequest = wrapRequestContinuationWithFrame({
          ctx,
          request,
          frame: frameCont,
        });
        const wrappedOutcome = ctx.effectsRuntime.makeOutcomeEffect(wrappedRequest);

        const wrappedLocal = allocateTempLocal(ctx.effectsRuntime.outcomeType, fnCtx);
        const ops = [
          ctx.mod.local.set(wrappedLocal.index, wrappedOutcome),
          ...cleanup,
          ctx.mod.return(
            ctx.mod.local.get(wrappedLocal.index, wrappedLocal.type)
          ),
        ];
        return ctx.mod.block(null, ops, binaryen.none);
      })()
    : ctx.mod.unreachable();

  if (valueType === binaryen.none) {
    ops.push(ctx.mod.if(tagIsValue, valueResult, effectReturn));
    return {
      expr: ctx.mod.block(
        null,
        ops,
        getExprBinaryenType(callId, ctx, lookupKey)
      ),
      usedReturnCall: false,
    };
  }

  const resultTemp = allocateTempLocal(valueType, fnCtx);
  ops.push(
    ctx.mod.if(
      tagIsValue,
      ctx.mod.local.set(resultTemp.index, valueResult),
      effectReturn
    ),
    ctx.mod.local.get(resultTemp.index, valueType)
  );

  return {
    expr: ctx.mod.block(null, ops, getExprBinaryenType(callId, ctx, lookupKey)),
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
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  const callInstanceKey = fnCtx.instanceKey ?? typeInstanceKey;
  const callee = ctx.hir.expressions.get(expr.callee);
  const expectTraitDispatch = ctx.typing.callTraitDispatches.has(expr.id);
  if (!callee) {
    throw new Error(`codegen missing callee expression ${expr.callee}`);
  }

  if (callee.exprKind === "identifier") {
    const continuation = fnCtx.continuations?.get(callee.symbol);
    if (continuation) {
      return compileContinuationCall({
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
    const targets = ctx.typing.callTargets.get(expr.id);
    const targetSymbol =
      (callInstanceKey && targets?.get(callInstanceKey)) ??
      (typeInstanceKey && targets?.get(typeInstanceKey)) ??
      (targets && targets.size === 1
        ? targets.values().next().value
        : undefined);
    if (typeof targetSymbol !== "number") {
      throw new Error("codegen missing overload resolution for indirect call");
    }
    const traitDispatch = compileTraitDispatchCall({
      expr,
      calleeSymbol: targetSymbol,
      ctx,
      fnCtx,
      compileExpr,
      tailPosition,
      expectedResultTypeId,
    });
    if (traitDispatch) {
      return traitDispatch;
    }
    if (expectTraitDispatch) {
      throw new Error(
        "codegen missing trait dispatch target for indirect call"
      );
    }
    const targetMeta = getFunctionMetadataForCall({
      symbol: targetSymbol,
      callId: expr.id,
      ctx,
    });
    if (!targetMeta) {
      throw new Error(`codegen cannot call symbol ${targetSymbol}`);
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
      typeInstanceKey,
    });
  }

  const calleeTypeId = getRequiredExprType(expr.callee, ctx, typeInstanceKey);
  const calleeDesc = ctx.typing.arena.get(calleeTypeId);

  if (callee.exprKind === "identifier") {
    const symbolRecord = ctx.symbolTable.getSymbol(callee.symbol);
    if (symbolRecord.kind === "effect-op") {
      return ctx.effectsBackend.compileEffectOpCall({
        expr,
        calleeSymbol: callee.symbol,
        ctx,
        fnCtx,
        compileExpr,
      });
    }
    const intrinsicMetadata = (symbolRecord.metadata ?? {}) as {
      intrinsic?: boolean;
      intrinsicName?: string;
      intrinsicUsesSignature?: boolean;
    };
    const traitDispatch = compileTraitDispatchCall({
      expr,
      calleeSymbol: callee.symbol,
      ctx,
      fnCtx,
      compileExpr,
      tailPosition,
      expectedResultTypeId,
    });
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
      const args = expr.args.map(
        (arg) => compileExpr({ exprId: arg.expr, ctx, fnCtx }).expr
      );
      return {
        expr: compileIntrinsicCall({
          name: intrinsicMetadata.intrinsicName ?? symbolRecord.name,
          call: expr,
          args,
          ctx,
          fnCtx,
          instanceKey: typeInstanceKey,
        }),
        usedReturnCall: false,
      };
    }

    const meta = getFunctionMetadataForCall({
      symbol: callee.symbol,
      callId: expr.id,
      ctx,
    });
    if (meta) {
      const args = compileCallArguments(expr, meta, ctx, fnCtx, compileExpr);
      return emitResolvedCall(meta, args, expr.id, ctx, fnCtx, {
        tailPosition,
        expectedResultTypeId,
        typeInstanceKey,
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

export const compileEffectOpCall = ({
  expr,
  calleeSymbol,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirCallExpr;
  calleeSymbol: SymbolId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression => {
  const site = ctx.effectLowering.sitesByExpr.get(expr.id);
  if (!site || site.kind !== "perform") {
    throw new Error("codegen missing effect lowering info for perform site");
  }
  const signature = ctx.typing.functions.getSignature(calleeSymbol);
  if (!signature) {
    throw new Error("codegen missing effect operation signature");
  }
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  const args = expr.args.map((arg, index) => {
    const expectedTypeId = signature.parameters[index]?.type;
    const actualTypeId = getRequiredExprType(arg.expr, ctx, typeInstanceKey);
    const value = compileExpr({ exprId: arg.expr, ctx, fnCtx });
    return coerceValueToType({
      value: value.expr,
      actualType: actualTypeId,
      targetType: expectedTypeId,
      ctx,
      fnCtx,
    });
  });

  const envValues = site.envFields.map((field) => {
    switch (field.sourceKind) {
      case "site":
        return ctx.mod.i32.const(site.siteOrder);
      case "handler":
        return currentHandlerValue(ctx, fnCtx);
      case "param":
      case "local": {
        if (typeof field.symbol !== "number") {
          throw new Error("missing symbol for env field");
        }
        const binding = getRequiredBinding(field.symbol, ctx, fnCtx);
        return loadBindingValue(binding, ctx);
      }
    }
  });

  const contRefType = ensureContinuationFunction({ site, ctx });
  const env = initStruct(ctx.mod, site.envType, envValues as number[]);
  const contRef = refFunc(ctx.mod, site.contFnName, contRefType);
  const continuation = ctx.effectsRuntime.makeContinuation({
    fnRef: contRef,
    env,
    site: ctx.mod.i32.const(site.siteOrder),
  });
  const argsBoxed = site.argsType
    ? initStruct(ctx.mod, site.argsType, args as number[])
    : ctx.mod.ref.null(binaryen.eqref);
  const request = ctx.effectsRuntime.makeEffectRequest({
    effectId: ctx.mod.i32.const(site.effectId),
    opId: ctx.mod.i32.const(site.opId),
    resumeKind: ctx.mod.i32.const(site.resumeKind),
    args: argsBoxed,
    continuation,
    tailGuard: ctx.effectsRuntime.makeTailGuard(),
  });

  const exprRef = ctx.effectsRuntime.makeOutcomeEffect(request);

  if (fnCtx.effectful) {
    const cleanup = handlerCleanupOps({ ctx, fnCtx });
    const temp = allocateTempLocal(ctx.effectsRuntime.outcomeType, fnCtx);
    const ops: binaryen.ExpressionRef[] = [
      ctx.mod.local.set(temp.index, exprRef),
      ...cleanup,
      ctx.mod.return(ctx.mod.local.get(temp.index, temp.type)),
      ctx.mod.unreachable(),
    ];
    return {
      expr: ctx.mod.block(
        null,
        ops,
        getExprBinaryenType(expr.id, ctx, typeInstanceKey)
      ),
      usedReturnCall: false,
    };
  }

  return {
    expr: exprRef,
    usedReturnCall: false,
  };
};

const compileContinuationCall = ({
  expr,
  continuation,
  ctx,
  fnCtx,
  compileExpr,
  expectedResultTypeId,
  tailPosition,
}: {
  expr: HirCallExpr;
  continuation: ContinuationBinding;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  expectedResultTypeId?: TypeId;
  tailPosition: boolean;
}): CompiledExpression => {
  const resumeTypeId = continuation.returnTypeId;
  const resumeWasmType = wasmTypeFor(resumeTypeId, ctx);
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  if (resumeWasmType === binaryen.none && expr.args.length > 0) {
    throw new Error("continuation does not take a value");
  }
  if (resumeWasmType !== binaryen.none && expr.args.length === 0) {
    throw new Error("continuation call requires a value");
  }
  const args =
    resumeWasmType === binaryen.none
      ? []
      : expr.args.map((arg, index) => {
          if (index > 0) {
            throw new Error("continuation calls accept at most one argument");
          }
          const actualTypeId = getRequiredExprType(
            arg.expr,
            ctx,
            typeInstanceKey
          );
          const value = compileExpr({ exprId: arg.expr, ctx, fnCtx });
          return coerceValueToType({
            value: value.expr,
            actualType: actualTypeId,
            targetType: resumeTypeId,
            ctx,
            fnCtx,
          });
        });

  const guardRef = ctx.mod.local.get(
    continuation.tailGuardLocal.index,
    continuation.tailGuardLocal.type
  );
  const contRef = ctx.mod.local.get(
    continuation.continuationLocal.index,
    continuation.continuationLocal.type
  );
  const guardOps: binaryen.ExpressionRef[] = [
    ctx.mod.if(
      ctx.mod.i32.ge_u(
        ctx.effectsRuntime.tailGuardObserved(guardRef),
        ctx.effectsRuntime.tailGuardExpected(guardRef)
      ),
      ctx.mod.unreachable(),
      ctx.mod.nop()
    ),
    ctx.effectsRuntime.bumpTailGuardObserved(guardRef),
  ];

  const resumeBox =
    resumeWasmType === binaryen.none
      ? ctx.mod.ref.null(binaryen.eqref)
      : boxOutcomeValue({
          value: args[0]!,
          valueType: resumeWasmType,
          ctx,
        });
  const callArgs = [ctx.effectsRuntime.continuationEnv(contRef), resumeBox];
  const fnRefType = functionRefType({
    params: [binaryen.anyref, binaryen.eqref],
    result: ctx.effectsRuntime.outcomeType,
    ctx,
  });
  const continuationCall = callRef(
    ctx.mod,
    refCast(ctx.mod, ctx.effectsRuntime.continuationFn(contRef), fnRefType),
    callArgs as number[],
    ctx.effectsRuntime.outcomeType
  );
  const callExpr =
    guardOps.length === 0
      ? continuationCall
      : ctx.mod.block(null, [...guardOps, continuationCall], ctx.effectsRuntime.outcomeType);

  return lowerEffectfulCallResult({
    callExpr,
    callId: expr.id,
    returnTypeId: continuation.returnTypeId,
    expectedResultTypeId,
    tailPosition,
    typeInstanceKey,
    ctx,
    fnCtx,
  });
};

const compileTraitDispatchCall = ({
  expr,
  calleeSymbol,
  ctx,
  fnCtx,
  compileExpr,
  tailPosition,
  expectedResultTypeId,
}: {
  expr: HirCallExpr;
  calleeSymbol: SymbolId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  tailPosition: boolean;
  expectedResultTypeId?: TypeId;
}): CompiledExpression | undefined => {
  if (expr.args.length === 0) {
    return undefined;
  }
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  const mapping = ctx.typing.traitMethodImpls.get(calleeSymbol);
  if (!mapping) {
    return undefined;
  }
  const receiverTypeId = getRequiredExprType(
    expr.args[0].expr,
    ctx,
    typeInstanceKey
  );
  const receiverDesc = ctx.typing.arena.get(receiverTypeId);
  if (
    receiverDesc.kind !== "trait" ||
    receiverDesc.owner !== mapping.traitSymbol
  ) {
    return undefined;
  }

  const meta = getFunctionMetadataForCall({
    symbol: calleeSymbol,
    callId: expr.id,
    ctx,
  });
  if (!meta) {
    return undefined;
  }

  const userParamTypes = meta.effectful
    ? meta.paramTypes.slice(2)
    : meta.paramTypes.slice(1);
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
    const actualTypeId = getRequiredExprType(arg.expr, ctx, typeInstanceKey);
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
    ? lowerEffectfulCallResult({
        callExpr,
        callId: expr.id,
        returnTypeId: getRequiredExprType(expr.id, ctx, typeInstanceKey),
        expectedResultTypeId,
        tailPosition,
        typeInstanceKey,
        ctx,
        fnCtx,
      })
    : { expr: callExpr, usedReturnCall: false };
  ops.push(lowered.expr);
  const binaryenResult = getExprBinaryenType(expr.id, ctx, typeInstanceKey);

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
    typeInstanceKey,
  } = options;
  const lookupKey = typeInstanceKey ?? meta.instanceKey;
  const returnTypeId = getRequiredExprType(callId, ctx, lookupKey);
  const expectedTypeId = expectedResultTypeId ?? returnTypeId;
  const callArgs = meta.effectful
    ? [currentHandlerValue(ctx, fnCtx), ...args]
    : args;

  if (meta.effectful) {
    const callExpr = ctx.mod.call(
      meta.wasmName,
      callArgs as number[],
      meta.resultType
    );
    return lowerEffectfulCallResult({
      callExpr,
      callId,
      returnTypeId,
      expectedResultTypeId,
      tailPosition,
      typeInstanceKey,
      ctx,
      fnCtx,
    });
  }

  const allowReturnCall =
    tailPosition &&
    !fnCtx.effectful &&
    !requiresStructuralConversion(returnTypeId, expectedTypeId, ctx);

  if (allowReturnCall) {
    return {
      expr: ctx.mod.return_call(
        meta.wasmName,
        callArgs as number[],
        getExprBinaryenType(callId, ctx, lookupKey)
      ),
      usedReturnCall: true,
    };
  }

  return {
    expr: ctx.mod.call(
      meta.wasmName,
      callArgs as number[],
      getExprBinaryenType(callId, ctx, lookupKey)
    ),
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
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  return call.args.map((arg, index) => {
    const expectedTypeId = meta.paramTypeIds[index];
    const actualTypeId = getRequiredExprType(arg.expr, ctx, typeInstanceKey);
    const value = compileExpr({ exprId: arg.expr, ctx, fnCtx });
    return coerceValueToType({
      value: value.expr,
      actualType: actualTypeId,
      targetType: expectedTypeId,
      ctx,
      fnCtx,
    });
  });
};

const compileClosureArguments = (
  call: HirCallExpr,
  desc: {
    parameters: readonly { type: TypeId; label?: string; optional?: boolean }[];
  },
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): binaryen.ExpressionRef[] => {
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  return call.args.map((arg, index) => {
    const expectedTypeId = desc.parameters[index]?.type;
    const actualTypeId = getRequiredExprType(arg.expr, ctx, typeInstanceKey);
    const value = compileExpr({ exprId: arg.expr, ctx, fnCtx });
    return coerceValueToType({
      value: value.expr,
      actualType: actualTypeId,
      targetType: expectedTypeId,
      ctx,
      fnCtx,
    });
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
  if (expr.args.length !== calleeDesc.parameters.length) {
    throw new Error("call argument count mismatch");
  }

  const base = getClosureTypeInfo(calleeTypeId, ctx);
  const effectful =
    typeof calleeDesc.effectRow === "number" &&
    ctx.typing.effects.getRow(calleeDesc.effectRow).operations.length > 0;
  if (effectful && process.env.DEBUG_EFFECTS === "1") {
    console.log("[effects] closure call", {
      returnType: calleeDesc.returnType,
      row: ctx.typing.effects.getRow(calleeDesc.effectRow),
    });
  }
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  const closureValue = compileExpr({ exprId: expr.callee, ctx, fnCtx });
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
    calleeDesc,
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
    ? lowerEffectfulCallResult({
        callExpr: call,
        callId: expr.id,
        returnTypeId: calleeDesc.returnType,
        expectedResultTypeId,
        tailPosition,
        typeInstanceKey,
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
            getExprBinaryenType(expr.id, ctx, typeInstanceKey)
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
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  let currentValue = compileExpr({ exprId: expr.callee, ctx, fnCtx });
  let currentTypeId = calleeTypeId;
  let argIndex = 0;

  while (argIndex < expr.args.length) {
    const currentDesc = ctx.typing.arena.get(currentTypeId);
    if (currentDesc.kind !== "function") {
      throw new Error("attempted to call a non-function value");
    }

    const paramCount = currentDesc.parameters.length;
    const slice = expr.args.slice(argIndex, argIndex + paramCount);
    if (slice.length !== paramCount) {
      throw new Error("call argument count mismatch");
    }

    const base = getClosureTypeInfo(currentTypeId, ctx);
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
      currentDesc.kind === "function" &&
      typeof currentDesc.effectRow === "number" &&
      ctx.typing.effects.getRow(currentDesc.effectRow).operations.length > 0;
    if (effectful && process.env.DEBUG_EFFECTS === "1") {
      console.log("[effects] curried closure call", {
        returnType: currentDesc.returnType,
        row: ctx.typing.effects.getRow(currentDesc.effectRow),
      });
    }
    const returnTypeId =
      currentDesc.kind === "function" ? currentDesc.returnType : calleeTypeId;
    const returnWasmType = wasmTypeFor(returnTypeId, ctx);
    const args = slice.map((arg, index) => {
      const expectedTypeId = currentDesc.parameters[index]?.type;
      const actualTypeId = getRequiredExprType(arg.expr, ctx, typeInstanceKey);
      const value = compileExpr({ exprId: arg.expr, ctx, fnCtx });
      return coerceValueToType({
        value: value.expr,
        actualType: actualTypeId,
        targetType: expectedTypeId,
        ctx,
        fnCtx,
      });
    });

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

    const isFinalSlice = argIndex + paramCount >= expr.args.length;
    const lowered = effectful
      ? lowerEffectfulCallResult({
          callExpr: call,
          callId: expr.id,
          returnTypeId,
          expectedResultTypeId: isFinalSlice ? expectedResultTypeId : undefined,
          tailPosition: tailPosition && isFinalSlice,
          typeInstanceKey,
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
    argIndex += paramCount;
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
  const tempName = `__trait_method_sig_${traitDispatchSigCounter++}_${
    params.length
  }`;
  const temp = ctx.mod.addFunction(
    tempName,
    binaryen.createType(params as number[]),
    result,
    [],
    ctx.mod.nop()
  );
  const fnType = bin._BinaryenTypeFromHeapType(
    bin._BinaryenFunctionGetType(temp),
    false
  );
  ctx.mod.removeFunction(tempName);
  return fnType;
};

const getFunctionMetadataForCall = ({
  symbol,
  callId,
  ctx,
}: {
  symbol: number;
  callId: HirExprId;
  ctx: CodegenContext;
}): FunctionMetadata | undefined => {
  const rawKey = ctx.typing.callInstanceKeys.get(callId);
  const instance = rawKey
    ? ctx.functionInstances.get(scopedInstanceKey(ctx.moduleId, rawKey))
    : undefined;
  if (instance) {
    return instance;
  }
  const metas = ctx.functions.get(functionKey(ctx.moduleId, symbol));
  if (!metas || metas.length === 0) {
    return undefined;
  }
  if (!rawKey) {
    const genericMeta = metas.find((meta) => meta.typeArgs.length === 0);
    if (genericMeta) {
      return genericMeta;
    }
  }
  return metas[0];
};

const functionKey = (moduleId: string, symbol: number): string =>
  `${moduleId}::${symbol}`;

const scopedInstanceKey = (moduleId: string, instanceKey: string): string =>
  `${moduleId}::${instanceKey}`;
