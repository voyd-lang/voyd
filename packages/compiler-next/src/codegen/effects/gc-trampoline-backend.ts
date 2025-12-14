import binaryen from "binaryen";
import type { AugmentedBinaryen } from "@voyd/lib/binaryen-gc/types.js";
import type {
  CodegenContext,
  CompiledExpression,
  ContinuationBinding,
  ExpressionCompiler,
  FunctionContext,
  HirCallExpr,
  HirExprId,
  SymbolId,
  TypeId,
} from "../context.js";
import type { HirFunction, HirLambdaExpr, HirPattern } from "../../semantics/hir/index.js";
import type { HirStmtId } from "../../semantics/ids.js";
import type {
  ContinuationCallSite,
  ContinuationSite,
} from "./effect-lowering.js";
import { buildEffectLowering } from "./effect-lowering.js";
import { ensureDispatcher } from "./dispatcher.js";
import { handlerCleanupOps } from "./handler-stack.js";
import { wrapRequestContinuationWithFrame } from "./continuation-bind.js";
import { OUTCOME_TAGS } from "./runtime-abi.js";
import { wrapValueInOutcome, unboxOutcomeValue, boxOutcomeValue } from "./outcome-values.js";
import { buildGroupContinuationCfg } from "./continuation-cfg.js";
import { createGroupedContinuationExpressionCompiler } from "./continuation-compiler.js";
import {
  callRef,
  initStruct,
  refCast,
  refFunc,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import {
  allocateTempLocal,
  getRequiredBinding,
  loadBindingValue,
} from "../locals.js";
import { coerceValueToType } from "../structural.js";
import {
  getExprBinaryenType,
  getRequiredExprType,
  wasmTypeFor,
} from "../types.js";
import { compileEffectHandlerExpr } from "../expressions/effect-handler.js";
import type { EffectsBackend } from "./codegen-backend.js";

const bin = binaryen as unknown as AugmentedBinaryen;
let gcTrampolineSigCounter = 0;

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

const functionRefType = ({
  params,
  result,
  ctx,
}: {
  params: readonly binaryen.Type[];
  result: binaryen.Type;
  ctx: CodegenContext;
}): binaryen.Type => {
  const tempName = `__voyd_gc_trampoline_sig_${gcTrampolineSigCounter++}_${
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

const findLambdaByExprId = (
  exprId: HirExprId,
  ctx: CodegenContext
): { expr: HirLambdaExpr; returnTypeId: TypeId } => {
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr || expr.exprKind !== "lambda") {
    throw new Error(`could not find lambda expression ${exprId}`);
  }
  const typeId =
    ctx.typing.resolvedExprTypes.get(exprId) ??
    ctx.typing.table.getExprType(exprId) ??
    ctx.typing.primitives.unknown;
  const desc = ctx.typing.arena.get(typeId);
  if (desc.kind !== "function") {
    throw new Error("lambda missing function type");
  }
  return { expr, returnTypeId: desc.returnType };
};

const collectFunctionLocalSymbols = (
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

const collectLambdaLocalSymbols = (
  expr: HirLambdaExpr,
  ctx: CodegenContext
): Set<SymbolId> => {
  const symbols = new Set<SymbolId>();
  expr.captures.forEach((capture) => symbols.add(capture.symbol));
  expr.parameters.forEach((param) => symbols.add(param.symbol));

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

  const visitExpr = (exprId: HirExprId): void => {
    const node = ctx.hir.expressions.get(exprId);
    if (!node) return;
    switch (node.exprKind) {
      case "block":
        node.statements.forEach((stmtId) => visitStmt(stmtId));
        if (typeof node.value === "number") visitExpr(node.value);
        return;
      case "call":
        visitExpr(node.callee);
        node.args.forEach((arg) => visitExpr(arg.expr));
        return;
      case "tuple":
        node.elements.forEach((element) => visitExpr(element));
        return;
      case "loop":
      case "while":
        visitExpr(node.body);
        if (node.exprKind === "while") {
          visitExpr(node.condition);
        }
        return;
      case "if":
      case "cond":
        node.branches.forEach((branch) => {
          visitExpr(branch.condition);
          visitExpr(branch.value);
        });
        if (typeof node.defaultBranch === "number") {
          visitExpr(node.defaultBranch);
        }
        return;
      case "match":
        visitExpr(node.discriminant);
        node.arms.forEach((arm) => {
          if (typeof arm.guard === "number") visitExpr(arm.guard);
          visitExpr(arm.value);
        });
        return;
      case "object-literal":
        node.entries.forEach((entry) => visitExpr(entry.value));
        return;
      case "field-access":
        visitExpr(node.target);
        return;
      case "assign":
        if (typeof node.target === "number") visitExpr(node.target);
        visitExpr(node.value);
        if (node.pattern) visitPattern(node.pattern);
        return;
      case "effect-handler":
        visitExpr(node.body);
        if (typeof node.finallyBranch === "number") {
          visitExpr(node.finallyBranch);
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

  visitExpr(expr.body);
  return symbols;
};

const sameContinuationOwner = (
  a: ContinuationSite["owner"],
  b: ContinuationSite["owner"]
): boolean => {
  if (a.kind !== b.kind) return false;
  return a.kind === "function" ? a.symbol === b.symbol : a.exprId === b.exprId;
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

  const continuationBody = (() => {
    if (site.owner.kind === "function") {
      const { fn, returnTypeId } = findFunctionBySymbol(site.owner.symbol, ctx);
      return {
        bodyExprId: fn.body,
        cfgFn: fn,
        localsToSeed: collectFunctionLocalSymbols(fn, ctx),
        returnTypeId,
      };
    }
    const { expr, returnTypeId } = findLambdaByExprId(site.owner.exprId, ctx);
    return {
      bodyExprId: expr.body,
      cfgFn: { body: expr.body } as HirFunction,
      localsToSeed: collectLambdaLocalSymbols(expr, ctx),
      returnTypeId,
    };
  })();

  const { cfgFn, returnTypeId, localsToSeed, bodyExprId } = continuationBody;
  const params = [binaryen.anyref, resumeBoxType];
  const returnWasmType = wasmTypeFor(returnTypeId, ctx);

  const groupSites = ctx.effectLowering.sites.filter(
    (candidate) =>
      sameContinuationOwner(candidate.owner, site.owner) &&
      candidate.contFnName === contName
  );

  const locals: binaryen.Type[] = [];
  const fnCtx: FunctionContext = {
    bindings: new Map(),
    tempLocals: new Map(),
    locals,
    nextLocalIndex: params.length,
    returnTypeId,
    instanceKey: undefined,
    typeInstanceKey: undefined,
    effectful: true,
  };

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

  const tempIds = new Set<number>();
  groupSites.forEach((groupSite) => {
    groupSite.envFields.forEach((field) => {
      if (typeof field.tempId !== "number") return;
      tempIds.add(field.tempId);
    });
  });
  tempIds.forEach((tempId) => {
    const typeId =
      ctx.effectLowering.tempTypeIds.get(tempId) ?? ctx.typing.primitives.unknown;
    const wasmType = wasmTypeFor(typeId, ctx);
    fnCtx.tempLocals.set(tempId, allocateTempLocal(wasmType, fnCtx, typeId));
  });

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
        fn: cfgFn,
        groupSites,
        ctx,
      });
      cfgCache.set(contName, builtCfg);
      return builtCfg;
    })();

  fnCtx.continuation = { cfg, startedLocal, activeSiteLocal };

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
    exprId: bodyExprId,
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
      if (typeof field.tempId === "number") {
        const binding = fnCtx.tempLocals.get(field.tempId);
        if (!binding) {
          throw new Error("missing temp local binding for env restore");
        }
        initOps.push(ctx.mod.local.set(binding.index, value));
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
        const site = !tailPosition
          ? ctx.effectLowering.sitesByExpr.get(callId)
          : undefined;
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
              if (typeof field.tempId === "number") {
                const binding = fnCtx.tempLocals.get(field.tempId);
                if (!binding) {
                  throw new Error("missing temp local binding for call env capture");
                }
                return ctx.mod.local.get(binding.index, binding.type);
              }
              if (typeof field.symbol !== "number") {
                throw new Error("missing symbol for env field");
              }
              const binding = getRequiredBinding(field.symbol, ctx, fnCtx);
              return loadBindingValue(binding, ctx);
            }
          }
        });

        const contRefType = ensureContinuationFunction({ site: callSite, ctx });
        const frameEnv = initStruct(
          ctx.mod,
          callSite.envType,
          frameEnvValues as number[]
        );
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
      : ctx.mod.block(
          null,
          [...guardOps, continuationCall],
          ctx.effectsRuntime.outcomeType
        );

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

const compileEffectOpCall = ({
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
        if (typeof field.tempId === "number") {
          const binding = fnCtx.tempLocals.get(field.tempId);
          if (!binding) {
            throw new Error("missing temp local binding for perform env capture");
          }
          return ctx.mod.local.get(binding.index, binding.type);
        }
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

export const createGcTrampolineBackend = (): EffectsBackend => ({
  kind: "gc-trampoline",
  buildLowering: ({ ctx, siteCounter }) => buildEffectLowering({ ctx, siteCounter }),
  lowerEffectfulCallResult: (params) => lowerEffectfulCallResult(params),
  compileContinuationCall: (params) => compileContinuationCall(params),
  compileEffectOpCall: (params) => compileEffectOpCall(params),
  compileEffectHandlerExpr: ({
    expr,
    ctx,
    fnCtx,
    compileExpr,
    tailPosition,
    expectedResultTypeId,
  }) =>
    compileEffectHandlerExpr(
      expr,
      ctx,
      fnCtx,
      compileExpr,
      tailPosition,
      expectedResultTypeId
    ),
});
