import binaryen from "binaryen";
import type { AugmentedBinaryen } from "@voyd/lib/binaryen-gc/types.js";
import type {
  CodegenContext,
  FunctionContext,
  HirExprId,
  SymbolId,
  TypeId,
} from "../../context.js";
import type { HirFunction, HirLambdaExpr, HirPattern } from "../../../semantics/hir/index.js";
import type {
  ContinuationSite,
  ContinuationSiteOwner,
} from "../effect-lowering.js";
import type { ResumeKind } from "../runtime-abi.js";
import {
  refCast,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import { allocateTempLocal } from "../../locals.js";
import { wasmTypeFor } from "../../types.js";
import { walkHirExpression, walkHirPattern } from "../../hir-walk.js";
import { buildGroupContinuationCfg } from "../continuation-cfg.js";
import { createGroupedContinuationExpressionCompiler } from "../continuation-compiler.js";
import { wrapValueInOutcome } from "../outcome-values.js";
import { functionRefType } from "./shared.js";
import {
  handlerClauseContinuationTempId,
  handlerClauseTailGuardTempId,
} from "../effect-lowering/handler-clause-temp-ids.js";
import { effectsFacade } from "../facade.js";

const bin = binaryen as unknown as AugmentedBinaryen;

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

const collectFunctionLocalSymbols = (fn: HirFunction, ctx: CodegenContext): Set<SymbolId> => {
  const symbols = new Set<SymbolId>();
  const visitor = {
    onPattern: (pattern: HirPattern) => {
      if (pattern.kind !== "identifier") return;
      symbols.add(pattern.symbol);
    },
  };

  fn.parameters.forEach((param) => walkHirPattern({ pattern: param.pattern, visitor }));
  walkHirExpression({ exprId: fn.body, ctx, visitor, visitLambdaBodies: false });
  return symbols;
};

const collectLambdaLocalSymbols = (expr: HirLambdaExpr, ctx: CodegenContext): Set<SymbolId> => {
  const symbols = new Set<SymbolId>();
  expr.captures.forEach((capture) => symbols.add(capture.symbol));
  expr.parameters.forEach((param) => symbols.add(param.symbol));

  const visitor = {
    onPattern: (pattern: HirPattern) => {
      if (pattern.kind !== "identifier") return;
      symbols.add(pattern.symbol);
    },
  };

  walkHirExpression({ exprId: expr.body, ctx, visitor, visitLambdaBodies: false });
  return symbols;
};

const sameContinuationOwner = (
  a: ContinuationSiteOwner,
  b: ContinuationSiteOwner
): boolean => {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "function":
      return a.symbol === (b as typeof a).symbol;
    case "lambda":
      return a.exprId === (b as typeof a).exprId;
    case "handler-clause":
      return (
        a.handlerExprId === (b as typeof a).handlerExprId &&
        a.clauseIndex === (b as typeof a).clauseIndex
      );
  }
};

const shouldCaptureIdentifierSymbol = (symbol: SymbolId, ctx: CodegenContext): boolean =>
  ctx.symbolTable.getScope(ctx.symbolTable.getSymbol(symbol).scope).kind !== "module";

const collectHandlerClauseLocalSymbols = ({
  handlerExprId,
  clauseIndex,
  ctx,
}: {
  handlerExprId: HirExprId;
  clauseIndex: number;
  ctx: CodegenContext;
}): Set<SymbolId> => {
  const symbols = new Set<SymbolId>();
  const handler = ctx.hir.expressions.get(handlerExprId);
  if (!handler || handler.exprKind !== "effect-handler") {
    throw new Error(`could not find effect handler expression ${handlerExprId}`);
  }
  const clause = handler.handlers[clauseIndex];
  if (!clause) {
    throw new Error(`missing handler clause ${handlerExprId}:${clauseIndex}`);
  }

  clause.parameters.forEach((param) => symbols.add(param.symbol));

  walkHirExpression({
    exprId: clause.body,
    ctx,
    visitor: {
      onExpr: (_exprId, expr) => {
        if (expr.exprKind !== "identifier") return;
        if (!shouldCaptureIdentifierSymbol(expr.symbol, ctx)) return;
        symbols.add(expr.symbol);
      },
      onPattern: (pattern: HirPattern) => {
        if (pattern.kind !== "identifier") return;
        symbols.add(pattern.symbol);
      },
    },
    visitLambdaBodies: false,
  });
  return symbols;
};

const findHandlerClauseByOwner = ({
  handlerExprId,
  clauseIndex,
  ctx,
}: {
  handlerExprId: HirExprId;
  clauseIndex: number;
  ctx: CodegenContext;
}): {
  bodyExprId: HirExprId;
  returnTypeId: TypeId;
  resumeSymbol?: SymbolId;
  resumeKind: ResumeKind;
} => {
  const handler = ctx.hir.expressions.get(handlerExprId);
  if (!handler || handler.exprKind !== "effect-handler") {
    throw new Error(`could not find effect handler expression ${handlerExprId}`);
  }
  const clause = handler.handlers[clauseIndex];
  if (!clause) {
    throw new Error(`missing handler clause ${handlerExprId}:${clauseIndex}`);
  }
  const signature = ctx.typing.functions.getSignature(clause.operation);
  if (!signature) {
    throw new Error("missing signature for effect handler clause operation");
  }
  const { resumeKind } = effectsFacade(ctx).effectOpIds(clause.operation);
  return {
    bodyExprId: clause.body,
    returnTypeId: signature.returnType,
    resumeSymbol: clause.parameters[0]?.symbol,
    resumeKind,
  };
};

export const ensureContinuationFunction = ({
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
        resumeSymbol: undefined,
        resumeKind: undefined,
      };
    }
    if (site.owner.kind === "handler-clause") {
      const { bodyExprId, returnTypeId, resumeSymbol, resumeKind } = findHandlerClauseByOwner({
        handlerExprId: site.owner.handlerExprId,
        clauseIndex: site.owner.clauseIndex,
        ctx,
      });
      return {
        bodyExprId,
        cfgFn: { body: bodyExprId } as HirFunction,
        localsToSeed: collectHandlerClauseLocalSymbols({
          handlerExprId: site.owner.handlerExprId,
          clauseIndex: site.owner.clauseIndex,
          ctx,
        }),
        returnTypeId,
        resumeSymbol,
        resumeKind,
      };
    }
    const { expr, returnTypeId } = findLambdaByExprId(site.owner.exprId, ctx);
    return {
      bodyExprId: expr.body,
      cfgFn: { body: expr.body } as HirFunction,
      localsToSeed: collectLambdaLocalSymbols(expr, ctx),
      returnTypeId,
      resumeSymbol: undefined,
      resumeKind: undefined,
    };
  })();

  const { cfgFn, returnTypeId, localsToSeed, bodyExprId, resumeSymbol, resumeKind } =
    continuationBody;
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
    const typeId = ctx.typing.valueTypes.get(symbol) ?? ctx.typing.primitives.unknown;
    const wasmType = wasmTypeFor(typeId, ctx);
    const seeded = allocateTempLocal(wasmType, fnCtx, typeId);
    fnCtx.bindings.set(symbol, { ...seeded, kind: "local", typeId });
  });

  const handlerLocal = allocateTempLocal(ctx.effectsRuntime.handlerFrameType, fnCtx);
  fnCtx.currentHandler = { index: handlerLocal.index, type: handlerLocal.type };

  const startedLocal = allocateTempLocal(binaryen.i32, fnCtx, ctx.typing.primitives.i32);
  const activeSiteLocal = allocateTempLocal(binaryen.i32, fnCtx, ctx.typing.primitives.i32);

  const tempFields = new Map<number, { wasmType: binaryen.Type; typeId: TypeId }>();
  groupSites.forEach((groupSite) => {
    groupSite.envFields.forEach((field) => {
      if (typeof field.tempId !== "number") return;
      if (tempFields.has(field.tempId)) return;
      tempFields.set(field.tempId, { wasmType: field.wasmType, typeId: field.typeId });
    });
  });
  tempFields.forEach((spec, tempId) => {
    fnCtx.tempLocals.set(tempId, allocateTempLocal(spec.wasmType, fnCtx, spec.typeId));
  });

  const envParamIndex = 0;
  const baseEnvRef = () =>
    refCast(ctx.mod, ctx.mod.local.get(envParamIndex, binaryen.anyref), site.baseEnvType);
  const activeSiteFromEnv = structGetFieldValue({
    mod: ctx.mod,
    fieldIndex: 0,
    fieldType: binaryen.i32,
    exprRef: baseEnvRef(),
  });
  const initActiveSite = ctx.mod.local.set(activeSiteLocal.index, activeSiteFromEnv);
  const initStarted = ctx.mod.local.set(startedLocal.index, ctx.mod.i32.const(0));

  const cfgCache = ctx.effectsState.contCfgByName;
  const cfg =
    cfgCache.get(contName) ??
    (() => {
      const builtCfg = buildGroupContinuationCfg({ fn: cfgFn, groupSites, ctx });
      cfgCache.set(contName, builtCfg);
      return builtCfg;
    })();

  fnCtx.continuation = { cfg, startedLocal, activeSiteLocal };

  if (site.owner.kind === "handler-clause" && typeof resumeSymbol === "number") {
    if (resumeKind === undefined) {
      throw new Error("missing handler clause resume kind for continuation function");
    }
    const continuationLocal = fnCtx.tempLocals.get(
      handlerClauseContinuationTempId({
        handlerExprId: site.owner.handlerExprId,
        clauseIndex: site.owner.clauseIndex,
      })
    );
    if (!continuationLocal) {
      throw new Error("missing handler clause continuation local for continuation function");
    }
    const tailGuardLocal = fnCtx.tempLocals.get(
      handlerClauseTailGuardTempId({
        handlerExprId: site.owner.handlerExprId,
        clauseIndex: site.owner.clauseIndex,
      })
    );
    if (!tailGuardLocal) {
      throw new Error("missing handler clause tail guard local for continuation function");
    }
    fnCtx.continuations = new Map([
      [
        resumeSymbol,
        {
          continuationLocal,
          tailGuardLocal,
          resumeKind,
          resumeTypeId: returnTypeId,
        },
      ],
    ]);
  }

  const resumeLocal = {
    kind: "local",
    index: 1,
    type: resumeBoxType,
    typeId: ctx.typing.primitives.unknown,
  } as const;

  const continuationCompiler = createGroupedContinuationExpressionCompiler({
    cfg,
    activeSiteOrder: () => ctx.mod.local.get(activeSiteLocal.index, binaryen.i32),
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
  const needsWrap = binaryen.getExpressionType(bodyExpr.expr) === returnWasmType;
  const bodyOutcomeExpr = needsWrap
    ? wrapValueInOutcome({ valueExpr: bodyExpr.expr, valueType: returnWasmType, ctx })
    : bodyExpr.expr;

  let restoreChain = ctx.mod.nop();

  [...groupSites].reverse().forEach((groupSite) => {
    const envLocalGetter = () =>
      refCast(ctx.mod, ctx.mod.local.get(envParamIndex, binaryen.anyref), groupSite.envType);
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
      initOps.length === 0 ? ctx.mod.nop() : ctx.mod.block(null, initOps, binaryen.none);
    const matches = ctx.mod.i32.eq(
      ctx.mod.local.get(activeSiteLocal.index, binaryen.i32),
      ctx.mod.i32.const(groupSite.siteOrder)
    );
    restoreChain = ctx.mod.if(matches, restoreBlock, restoreChain);
  });

  const activeSiteGet = () => ctx.mod.local.get(activeSiteLocal.index, binaryen.i32);
  const matchAny = groupSites
    .map((groupSite) => ctx.mod.i32.eq(activeSiteGet(), ctx.mod.i32.const(groupSite.siteOrder)))
    .reduce((acc, exprRef) => ctx.mod.i32.or(acc, exprRef), ctx.mod.i32.const(0));

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
