import binaryen from "binaryen";
import {
  defineStructType,
  modBinaryenTypeToHeapType,
} from "@voyd/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  HirExprId,
  HirFunction,
  HirLambdaExpr,
  HirPattern,
  HirStmtId,
  SymbolId,
  TypeId,
} from "../context.js";
import { wasmTypeFor } from "../types.js";
import type { ResumeKind } from "./runtime-abi.js";
import { getEffectOpIds } from "./op-ids.js";
import { walkHirExpression, walkHirPattern } from "../hir-walk.js";

export type ContinuationFieldSource =
  | "param"
  | "local"
  | "handler"
  | "site";

export interface ContinuationEnvField {
  name: string;
  symbol?: SymbolId;
  typeId: TypeId;
  wasmType: binaryen.Type;
  sourceKind: ContinuationFieldSource;
  tempId?: number;
}

export interface ContinuationSiteBase {
  exprId: HirExprId;
  siteId: number;
  siteOrder: number;
  owner: ContinuationSiteOwner;
  contFnName: string;
  contRefType?: binaryen.Type;
  baseEnvType: binaryen.Type;
  envType: binaryen.Type;
  envFields: readonly ContinuationEnvField[];
  handlerAtSite: boolean;
  resumeValueTypeId: TypeId;
}

export interface ContinuationPerformSite extends ContinuationSiteBase {
  kind: "perform";
  effectSymbol: SymbolId;
  effectId: number;
  opId: number;
  resumeKind: ResumeKind;
  argsType?: binaryen.Type;
}

export interface ContinuationCallSite extends ContinuationSiteBase {
  kind: "call";
}

export type ContinuationSite = ContinuationPerformSite | ContinuationCallSite;

export interface EffectLoweringResult {
  sitesByExpr: Map<HirExprId, ContinuationSite>;
  sites: readonly ContinuationSite[];
  argsTypes: Map<SymbolId, binaryen.Type>;
  callArgTemps: Map<
    HirExprId,
    readonly { argIndex: number; tempId: number; typeId: TypeId }[]
  >;
  tempTypeIds: Map<number, TypeId>;
}

export type ContinuationSiteOwner =
  | { kind: "function"; symbol: SymbolId }
  | { kind: "lambda"; exprId: HirExprId };

type SiteCounter = { current: number };

interface SiteDraft {
  kind: "perform" | "call";
  exprId: HirExprId;
  liveAfter: ReadonlySet<SymbolId>;
  evalOrder: readonly HirExprId[];
  effectSymbol?: SymbolId;
  tempCaptures?: TempCaptureDraft[];
}

type LiveResult = {
  live: Set<SymbolId>;
  sites: SiteDraft[];
};

interface TempCaptureDraft {
  key: string;
  callExprId: HirExprId;
  argIndex: number;
  typeId: TypeId;
}

const callArgTempKey = ({
  callExprId,
  argIndex,
}: {
  callExprId: HirExprId;
  argIndex: number;
}): string => `callArg:${callExprId}:${argIndex}`;

const appendTempCaptures = (
  site: SiteDraft,
  captures: readonly TempCaptureDraft[]
): void => {
  if (captures.length === 0) return;
  if (!site.tempCaptures) {
    site.tempCaptures = [...captures];
    return;
  }
  const existing = new Set(site.tempCaptures.map((capture) => capture.key));
  captures.forEach((capture) => {
    if (existing.has(capture.key)) return;
    existing.add(capture.key);
    site.tempCaptures!.push(capture);
  });
};

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

const shouldLowerLambda = (expr: HirLambdaExpr, ctx: CodegenContext): boolean => {
  return ctx.effectsInfo.lambdas.get(expr.id)?.shouldLower ?? false;
};

const lambdaParamSymbolSet = (expr: HirLambdaExpr): ReadonlySet<SymbolId> =>
  new Set(expr.parameters.map((param) => param.symbol));

const definitionOrderForLambda = (
  expr: HirLambdaExpr,
  ctx: CodegenContext
): Map<SymbolId, number> => {
  const order = new Map<SymbolId, number>();
  let index = 0;

  const add = (symbol: SymbolId): void => {
    if (order.has(symbol)) return;
    order.set(symbol, index);
    index += 1;
  };

  expr.captures.forEach((capture) => add(capture.symbol));
  expr.parameters.forEach((param) => add(param.symbol));

  walkHirExpression({
    exprId: expr.body,
    ctx,
    visitLambdaBodies: false,
    visitor: {
      onPattern: (pattern) => {
        if (pattern.kind !== "identifier") return;
        add(pattern.symbol);
      },
    },
  });
  return order;
};

const cloneLive = (set: ReadonlySet<SymbolId>): Set<SymbolId> =>
  new Set(set);

const mergeLive = (
  ...sets: ReadonlySet<SymbolId>[]
): Set<SymbolId> => {
  const merged = new Set<SymbolId>();
  sets.forEach((entry) => entry.forEach((symbol) => merged.add(symbol)));
  return merged;
};

const collectPatternSymbols = (
  pattern: HirPattern,
  into: Set<SymbolId>
): void => {
  switch (pattern.kind) {
    case "identifier":
      into.add(pattern.symbol);
      return;
    case "destructure":
      pattern.fields.forEach((field) =>
        collectPatternSymbols(field.pattern, into)
      );
      if (pattern.spread) {
        collectPatternSymbols(pattern.spread, into);
      }
      return;
    case "tuple":
      pattern.elements.forEach((element) =>
        collectPatternSymbols(element, into)
      );
      return;
    case "type":
      if (pattern.binding) {
        collectPatternSymbols(pattern.binding, into);
      }
      return;
    case "wildcard":
      return;
  }
};

const analyzeStatement = ({
  stmtId,
  liveAfter,
  ctx,
}: {
  stmtId: HirStmtId;
  liveAfter: ReadonlySet<SymbolId>;
  ctx: CodegenContext;
}): LiveResult => {
  const stmt = ctx.hir.statements.get(stmtId);
  if (!stmt) {
    throw new Error(`codegen missing HirStatement ${stmtId}`);
  }

  switch (stmt.kind) {
    case "expr-stmt": {
      const res = analyzeExpr({
        exprId: stmt.expr,
        liveAfter,
        ctx,
      });
      return {
        live: mergeLive(liveAfter, res.live),
        sites: res.sites,
      };
    }
    case "return": {
      if (typeof stmt.value === "number") {
        const res = analyzeExpr({
          exprId: stmt.value,
          liveAfter: new Set(),
          ctx,
        });
        return { live: res.live, sites: res.sites };
      }
      return { live: new Set(), sites: [] };
    }
    case "let": {
      const res = analyzeExpr({
        exprId: stmt.initializer,
        liveAfter,
        ctx,
      });
      const patternSymbols = new Set<SymbolId>();
      collectPatternSymbols(stmt.pattern, patternSymbols);
      const live = mergeLive(res.live);
      patternSymbols.forEach((symbol) => live.delete(symbol));
      return { live, sites: res.sites };
    }
  }
};

const analyzeBlock = ({
  exprId,
  liveAfter,
  ctx,
}: {
  exprId: HirExprId;
  liveAfter: ReadonlySet<SymbolId>;
  ctx: CodegenContext;
}): LiveResult => {
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr || expr.exprKind !== "block") {
    throw new Error("analyzeBlock expects a block expression");
  }

  let live = cloneLive(liveAfter);
  const sites: SiteDraft[] = [];

  if (typeof expr.value === "number") {
    const valueRes = analyzeExpr({
      exprId: expr.value,
      liveAfter,
      ctx,
    });
    live = mergeLive(live, valueRes.live);
    sites.push(...valueRes.sites);
  }

  [...expr.statements].reverse().forEach((stmtId) => {
    const res = analyzeStatement({
      stmtId,
      liveAfter: live,
      ctx,
    });
    live = res.live;
    sites.push(...res.sites);
  });

  return { live, sites };
};

const mergeSiteResults = (...results: LiveResult[]): LiveResult => ({
  live: mergeLive(...results.map((res) => res.live)),
  sites: results.flatMap((res) => res.sites),
});

const analyzeExpr = ({
  exprId,
  liveAfter,
  ctx,
}: {
  exprId: HirExprId;
  liveAfter: ReadonlySet<SymbolId>;
  ctx: CodegenContext;
}): LiveResult => {
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    throw new Error(`codegen missing HirExpression ${exprId}`);
  }

  switch (expr.exprKind) {
    case "identifier":
      return {
        live: mergeLive(liveAfter, new Set([expr.symbol])),
        sites: [],
      };
    case "literal":
    case "overload-set":
    case "continue":
      return { live: cloneLive(liveAfter), sites: [] };
    case "break": {
      if (typeof expr.value === "number") {
        const res = analyzeExpr({
          exprId: expr.value,
          liveAfter: new Set(),
          ctx,
        });
        return { live: res.live, sites: res.sites };
      }
      return { live: new Set(), sites: [] };
    }
    case "call": {
      const callee = ctx.hir.expressions.get(expr.callee);
      const argResults: LiveResult[] = new Array(expr.args.length);
      let cursor = cloneLive(liveAfter);
      for (let index = expr.args.length - 1; index >= 0; index -= 1) {
        const arg = expr.args[index]!;
        const res = analyzeExpr({
          exprId: arg.expr,
          liveAfter: cursor,
          ctx,
        });
        cursor = mergeLive(cursor, res.live);
        argResults[index] = res;
      }
      const calleeResult =
        callee && callee.exprKind !== "identifier"
          ? analyzeExpr({ exprId: expr.callee, liveAfter: cursor, ctx })
          : { live: cursor, sites: [] };

      const hasSitesInArg = argResults.map((res) => res.sites.length > 0);
      const needsTemp = new Array(expr.args.length).fill(false);
      let suffixHasSites = false;
      for (let index = expr.args.length - 2; index >= 0; index -= 1) {
        suffixHasSites ||= hasSitesInArg[index + 1] ?? false;
        needsTemp[index] = suffixHasSites;
      }

      const tempCapturesByIndex: Array<TempCaptureDraft | undefined> = new Array(
        expr.args.length
      ).fill(undefined);
      needsTemp.forEach((needed, argIndex) => {
        if (!needed) return;
        const argExprId = expr.args[argIndex]!.expr;
        const typeId =
          ctx.typing.resolvedExprTypes.get(argExprId) ??
          ctx.typing.table.getExprType(argExprId) ??
          ctx.typing.primitives.unknown;
        tempCapturesByIndex[argIndex] = {
          key: callArgTempKey({ callExprId: expr.id, argIndex }),
          callExprId: expr.id,
          argIndex,
          typeId,
        };
      });

      for (let argIndex = 0; argIndex < argResults.length; argIndex += 1) {
        const res = argResults[argIndex]!;
        if (res.sites.length === 0) continue;
        const captures = tempCapturesByIndex
          .slice(0, argIndex)
          .filter((capture): capture is TempCaptureDraft => !!capture);
        if (captures.length === 0) continue;
        res.sites.forEach((site) => appendTempCaptures(site, captures));
      }

      const merged = mergeSiteResults(...argResults, calleeResult);
      const callInfo = ctx.effectsInfo.calls.get(expr.id);
      if (
        callee &&
        callee.exprKind === "identifier" &&
        ctx.effectsInfo.operations.has(callee.symbol)
      ) {
        const site: SiteDraft = {
          kind: "perform",
          exprId: expr.id,
          liveAfter,
          evalOrder: expr.args.map((arg) => arg.expr),
          effectSymbol: callee.symbol,
        };
        return {
          live: merged.live,
          sites: [...merged.sites, site],
        };
      }
      if (callInfo?.effectful) {
        const site: SiteDraft = {
          kind: "call",
          exprId: expr.id,
          liveAfter,
          evalOrder: expr.args.map((arg) => arg.expr),
        };
        return {
          live: merged.live,
          sites: [...merged.sites, site],
        };
      }
      return merged;
    }
    case "block":
      return analyzeBlock({ exprId, liveAfter, ctx });
    case "tuple": {
      const results = expr.elements.map((element) =>
        analyzeExpr({ exprId: element, liveAfter, ctx })
      );
      return mergeSiteResults(...results, { live: cloneLive(liveAfter), sites: [] });
    }
    case "loop":
      return analyzeExpr({ exprId: expr.body, liveAfter, ctx });
    case "while": {
      const conditionRes = analyzeExpr({
        exprId: expr.condition,
        liveAfter,
        ctx,
      });
      const bodyRes = analyzeExpr({
        exprId: expr.body,
        liveAfter: mergeLive(liveAfter, conditionRes.live),
        ctx,
      });
      return mergeSiteResults(conditionRes, bodyRes, {
        live: cloneLive(liveAfter),
        sites: [],
      });
    }
    case "cond":
    case "if": {
      const branchResults = expr.branches.map((branch) => {
        const valueRes = analyzeExpr({
          exprId: branch.value,
          liveAfter,
          ctx,
        });
        const condRes = analyzeExpr({
          exprId: branch.condition,
          liveAfter: mergeLive(liveAfter, valueRes.live),
          ctx,
        });
        return mergeSiteResults(condRes, valueRes);
      });
      const defaultRes =
        typeof expr.defaultBranch === "number"
          ? analyzeExpr({
              exprId: expr.defaultBranch,
              liveAfter,
              ctx,
            })
          : { live: cloneLive(liveAfter), sites: [] };
      return mergeSiteResults(...branchResults, defaultRes);
    }
    case "match": {
      const discriminantRes = analyzeExpr({
        exprId: expr.discriminant,
        liveAfter,
        ctx,
      });
      const armResults = expr.arms.map((arm) => {
        const guardRes =
          typeof arm.guard === "number"
            ? analyzeExpr({
                exprId: arm.guard,
                liveAfter,
                ctx,
              })
            : { live: cloneLive(liveAfter), sites: [] };
        const valueRes = analyzeExpr({
          exprId: arm.value,
          liveAfter,
          ctx,
        });
        return mergeSiteResults(guardRes, valueRes);
      });
      return mergeSiteResults(discriminantRes, ...armResults, {
        live: cloneLive(liveAfter),
        sites: [],
      });
    }
    case "object-literal": {
      const entryResults = expr.entries.map((entry) =>
        analyzeExpr({ exprId: entry.value, liveAfter, ctx })
      );
      return mergeSiteResults(...entryResults, {
        live: cloneLive(liveAfter),
        sites: [],
      });
    }
    case "field-access": {
      const res = analyzeExpr({
        exprId: expr.target,
        liveAfter,
        ctx,
      });
      return {
        live: mergeLive(liveAfter, res.live),
        sites: res.sites,
      };
    }
    case "assign": {
      const targetRes =
        typeof expr.target === "number"
          ? analyzeExpr({
              exprId: expr.target,
              liveAfter,
              ctx,
            })
          : { live: cloneLive(liveAfter), sites: [] };
      const valueRes = analyzeExpr({
        exprId: expr.value,
        liveAfter: mergeLive(liveAfter, targetRes.live),
        ctx,
      });
      const patternSymbols = new Set<SymbolId>();
      if (expr.pattern) {
        collectPatternSymbols(expr.pattern, patternSymbols);
      }
      const live = mergeLive(liveAfter, targetRes.live, valueRes.live);
      patternSymbols.forEach((symbol) => live.add(symbol));
      return {
        live,
        sites: [...targetRes.sites, ...valueRes.sites],
      };
    }
    case "lambda":
      return { live: cloneLive(liveAfter), sites: [] };
    case "effect-handler": {
      const finallyRes =
        typeof expr.finallyBranch === "number"
          ? analyzeExpr({ exprId: expr.finallyBranch, liveAfter, ctx })
          : { live: cloneLive(liveAfter), sites: [] as SiteDraft[] };
      const bodyRes = analyzeExpr({
        exprId: expr.body,
        liveAfter: mergeLive(liveAfter, finallyRes.live),
        ctx,
      });
      return {
        live: mergeLive(liveAfter, bodyRes.live, finallyRes.live),
        sites: [...bodyRes.sites, ...finallyRes.sites],
      };
    }
  }
};

const paramSymbolSet = (fn: HirFunction): Set<SymbolId> => {
  const symbols = new Set<SymbolId>();
  fn.parameters.forEach((param) =>
    collectPatternSymbols(param.pattern, symbols)
  );
  return symbols;
};

const definitionOrder = (
  fn: HirFunction,
  ctx: CodegenContext
): Map<SymbolId, number> => {
  const order = new Map<SymbolId, number>();
  let index = 0;
  const add = (symbol: SymbolId): void => {
    if (order.has(symbol)) return;
    order.set(symbol, index);
    index += 1;
  };

  const visitor = {
    onPattern: (pattern: HirPattern) => {
      if (pattern.kind !== "identifier") return;
      add(pattern.symbol);
    },
  };

  fn.parameters.forEach((param) => {
    walkHirPattern({ pattern: param.pattern, visitor });
  });
  walkHirExpression({
    exprId: fn.body,
    ctx,
    visitLambdaBodies: false,
    visitor,
  });
  return order;
};

const envFieldsFor = ({
  liveSymbols,
  params,
  ordering,
  ctx,
}: {
  liveSymbols: ReadonlySet<SymbolId>;
  params: ReadonlySet<SymbolId>;
  ordering: Map<SymbolId, number>;
  ctx: CodegenContext;
}): ContinuationEnvField[] =>
  Array.from(liveSymbols)
    .sort((a, b) => (ordering.get(a) ?? 0) - (ordering.get(b) ?? 0))
    .map((symbol) => ({
      name: ctx.symbolTable.getSymbol(symbol).name,
      symbol,
      typeId: ctx.typing.valueTypes.get(symbol) ?? ctx.typing.primitives.unknown,
      wasmType: wasmTypeFor(
        ctx.typing.valueTypes.get(symbol) ?? ctx.typing.primitives.unknown,
        ctx
      ),
      sourceKind: params.has(symbol) ? "param" : "local",
    }));

const ensureArgsType = ({
  opSymbol,
  paramTypes,
  ctx,
  cache,
}: {
  opSymbol: SymbolId;
  paramTypes: readonly TypeId[];
  ctx: CodegenContext;
  cache: Map<SymbolId, binaryen.Type>;
}): binaryen.Type | undefined => {
  if (paramTypes.length === 0) return undefined;
  const cached = cache.get(opSymbol);
  if (cached) return cached;
  const fields = paramTypes.map((typeId, index) => ({
    name: `arg${index}`,
    type: wasmTypeFor(typeId, ctx),
    mutable: false,
  }));
  const type = defineStructType(ctx.mod, {
    name: `voydEffectArgs_${sanitize(ctx.symbolTable.getSymbol(opSymbol).name)}`,
    fields,
    final: true,
  });
  cache.set(opSymbol, type);
  return type;
};

export const buildEffectLowering = ({
  ctx,
  siteCounter,
}: {
  ctx: CodegenContext;
  siteCounter: SiteCounter;
}): EffectLoweringResult => {
  const sites: ContinuationSite[] = [];
  const sitesByExpr = new Map<HirExprId, ContinuationSite>();
  const argsTypeCache = new Map<SymbolId, binaryen.Type>();
  const argsTypes = new Map<SymbolId, binaryen.Type>();
  const callArgTemps = new Map<
    HirExprId,
    { argIndex: number; tempId: number; typeId: TypeId }[]
  >();
  const tempTypeIds = new Map<number, TypeId>();
  const tempIdByKey = new Map<string, number>();
  let tempCounter = 0;
  const baseEnvType = ctx.effectsRuntime.contEnvBaseType;
  const baseHeapType = modBinaryenTypeToHeapType(ctx.mod, baseEnvType);

  const ensureTempId = (capture: TempCaptureDraft): number => {
    const existing = tempIdByKey.get(capture.key);
    if (typeof existing === "number") {
      return existing;
    }
    const next = tempCounter;
    tempCounter += 1;
    tempIdByKey.set(capture.key, next);
    tempTypeIds.set(next, capture.typeId);
    const list = callArgTemps.get(capture.callExprId) ?? [];
    list.push({
      argIndex: capture.argIndex,
      tempId: next,
      typeId: capture.typeId,
    });
    callArgTemps.set(capture.callExprId, list);
    return next;
  };

  ctx.hir.items.forEach((item) => {
    if (item.kind !== "function") return;
    const effectInfo = ctx.effectsInfo.functions.get(item.symbol);
    if (!effectInfo) return;
    if (effectInfo.pure && !effectInfo.hasHandlerInBody) {
      return;
    }

    const order = definitionOrder(item, ctx);
    const params = paramSymbolSet(item);
    const analysis = analyzeExpr({
      exprId: item.body,
      liveAfter: new Set(),
      ctx,
    });
    const fnName = sanitize(ctx.symbolTable.getSymbol(item.symbol).name);
    const contFnName = `__cont_${sanitize(ctx.moduleLabel)}_${fnName}_${item.symbol}`;

    analysis.sites.forEach((site) => {
      const resumeValueTypeId =
        site.kind === "perform"
          ? (() => {
              if (typeof site.effectSymbol !== "number") {
                throw new Error("perform site missing effect op symbol");
              }
              const signature = ctx.typing.functions.getSignature(
                site.effectSymbol
              );
              return signature?.returnType ?? ctx.typing.primitives.unknown;
            })()
          : (ctx.typing.resolvedExprTypes.get(site.exprId) ??
              ctx.typing.table.getExprType(site.exprId) ??
              ctx.typing.primitives.unknown);
      const tempCaptures = (site.tempCaptures ?? [])
        .slice()
        .sort((a, b) => {
          if (a.callExprId !== b.callExprId) return a.callExprId - b.callExprId;
          return a.argIndex - b.argIndex;
        })
        .filter((capture, index, all) => {
          const prev = all[index - 1];
          return !prev || prev.key !== capture.key;
        });
      const tempFields: ContinuationEnvField[] = tempCaptures.map((capture) => {
        const tempId = ensureTempId(capture);
        return {
          name: `tmp_${tempId}`,
          wasmType: wasmTypeFor(capture.typeId, ctx),
          typeId: capture.typeId,
          sourceKind: "local",
          tempId,
        };
      });
      const capturedFields = envFieldsFor({
        liveSymbols: site.liveAfter,
        params,
        ordering: order,
        ctx,
      });
      const envFields: ContinuationEnvField[] = [
        {
          name: "site",
          typeId: ctx.typing.primitives.i32,
          wasmType: binaryen.i32,
          sourceKind: "site",
        },
        {
          name: "handler",
          wasmType: ctx.effectsRuntime.handlerFrameType,
          typeId: ctx.typing.primitives.unknown,
          sourceKind: "handler",
        } as const,
        ...tempFields,
        ...capturedFields,
      ];
      const envType = defineStructType(ctx.mod, {
        name: `voydContEnv_${sanitize(ctx.moduleLabel)}_${fnName}_${siteCounter.current}`,
        fields: envFields.map((field) => ({
          name: field.name,
          type: field.wasmType,
          mutable: false,
        })),
        supertype: baseHeapType,
        final: true,
      });

      const performMeta =
        site.kind === "perform"
          ? (() => {
              if (typeof site.effectSymbol !== "number") {
                throw new Error("perform site missing effect op symbol");
              }
              const { effectId, opId, resumeKind, effectSymbol } = getEffectOpIds(
                site.effectSymbol,
                ctx
              );
              const signature = ctx.typing.functions.getSignature(
                site.effectSymbol
              );
              const argsType =
                signature &&
                ensureArgsType({
                  opSymbol: site.effectSymbol,
                  paramTypes: signature.parameters.map((param) => param.type),
                  ctx,
                  cache: argsTypeCache,
                });
              if (argsType) {
                argsTypes.set(site.effectSymbol, argsType);
              }
              return { effectId, opId, resumeKind, effectSymbol, argsType };
            })()
          : undefined;

    const lowered: ContinuationSite =
      site.kind === "perform" && performMeta
          ? {
              kind: "perform",
              exprId: site.exprId,
              siteId: siteCounter.current,
              siteOrder: siteCounter.current,
              owner: { kind: "function", symbol: item.symbol },
              effectSymbol: performMeta.effectSymbol,
              effectId: performMeta.effectId,
              opId: performMeta.opId,
              resumeKind: performMeta.resumeKind,
              contFnName,
              baseEnvType,
              envType,
              envFields,
              handlerAtSite: true,
              resumeValueTypeId,
              argsType: performMeta.argsType,
            }
          : {
              kind: "call",
              exprId: site.exprId,
              siteId: siteCounter.current,
              siteOrder: siteCounter.current,
              owner: { kind: "function", symbol: item.symbol },
              contFnName,
              baseEnvType,
              envType,
              envFields,
              handlerAtSite: true,
              resumeValueTypeId,
            };
      siteCounter.current += 1;
      sites.push(lowered);
      sitesByExpr.set(site.exprId, lowered);
    });
  });

  ctx.hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "lambda") return;
    if (!shouldLowerLambda(expr, ctx)) return;

    const order = definitionOrderForLambda(expr, ctx);
    const params = lambdaParamSymbolSet(expr);
    const fnName = `lambda_${expr.id}`;
    const contFnName = `__cont_${sanitize(ctx.moduleLabel)}_${fnName}_${expr.id}`;

    const analysis = analyzeExpr({
      exprId: expr.body,
      liveAfter: new Set(),
      ctx,
    });

    analysis.sites.forEach((site) => {
      const resumeValueTypeId =
        site.kind === "perform"
          ? (() => {
              if (typeof site.effectSymbol !== "number") {
                throw new Error("perform site missing effect op symbol");
              }
              const signature = ctx.typing.functions.getSignature(
                site.effectSymbol
              );
              return signature?.returnType ?? ctx.typing.primitives.unknown;
            })()
          : (ctx.typing.resolvedExprTypes.get(site.exprId) ??
              ctx.typing.table.getExprType(site.exprId) ??
              ctx.typing.primitives.unknown);
      const tempCaptures = (site.tempCaptures ?? [])
        .slice()
        .sort((a, b) => {
          if (a.callExprId !== b.callExprId) return a.callExprId - b.callExprId;
          return a.argIndex - b.argIndex;
        })
        .filter((capture, index, all) => {
          const prev = all[index - 1];
          return !prev || prev.key !== capture.key;
        });
      const tempFields: ContinuationEnvField[] = tempCaptures.map((capture) => {
        const tempId = ensureTempId(capture);
        return {
          name: `tmp_${tempId}`,
          wasmType: wasmTypeFor(capture.typeId, ctx),
          typeId: capture.typeId,
          sourceKind: "local",
          tempId,
        };
      });

      const capturedFields = envFieldsFor({
        liveSymbols: site.liveAfter,
        params,
        ordering: order,
        ctx,
      });

      const envFields: ContinuationEnvField[] = [
        {
          name: "site",
          typeId: ctx.typing.primitives.i32,
          wasmType: binaryen.i32,
          sourceKind: "site",
        },
        {
          name: "handler",
          wasmType: ctx.effectsRuntime.handlerFrameType,
          typeId: ctx.typing.primitives.unknown,
          sourceKind: "handler",
        } as const,
        ...tempFields,
        ...capturedFields,
      ];

      const envType = defineStructType(ctx.mod, {
        name: `voydContEnv_${sanitize(ctx.moduleLabel)}_${fnName}_${siteCounter.current}`,
        fields: envFields.map((field) => ({
          name: field.name,
          type: field.wasmType,
          mutable: false,
        })),
        supertype: baseHeapType,
        final: true,
      });

      const performMeta =
        site.kind === "perform"
          ? (() => {
              if (typeof site.effectSymbol !== "number") {
                throw new Error("perform site missing effect op symbol");
              }
              const { effectId, opId, resumeKind, effectSymbol } = getEffectOpIds(
                site.effectSymbol,
                ctx
              );
              const signature = ctx.typing.functions.getSignature(
                site.effectSymbol
              );
              const argsType =
                signature &&
                ensureArgsType({
                  opSymbol: site.effectSymbol,
                  paramTypes: signature.parameters.map((param) => param.type),
                  ctx,
                  cache: argsTypeCache,
                });
              if (argsType) {
                argsTypes.set(site.effectSymbol, argsType);
              }
              return { effectId, opId, resumeKind, effectSymbol, argsType };
            })()
          : undefined;

      const lowered: ContinuationSite =
        site.kind === "perform" && performMeta
          ? {
              kind: "perform",
              exprId: site.exprId,
              siteId: siteCounter.current,
              siteOrder: siteCounter.current,
              owner: { kind: "lambda", exprId: expr.id },
              effectSymbol: performMeta.effectSymbol,
              effectId: performMeta.effectId,
              opId: performMeta.opId,
              resumeKind: performMeta.resumeKind,
              contFnName,
              baseEnvType,
              envType,
              envFields,
              handlerAtSite: true,
              resumeValueTypeId,
              argsType: performMeta.argsType,
            }
          : {
              kind: "call",
              exprId: site.exprId,
              siteId: siteCounter.current,
              siteOrder: siteCounter.current,
              owner: { kind: "lambda", exprId: expr.id },
              contFnName,
              baseEnvType,
              envType,
              envFields,
              handlerAtSite: true,
              resumeValueTypeId,
            };

      siteCounter.current += 1;
      sites.push(lowered);
      sitesByExpr.set(site.exprId, lowered);
    });
  });

  callArgTemps.forEach((value, key) => {
    const unique = new Map<number, { argIndex: number; tempId: number; typeId: TypeId }>();
    value.forEach((entry) => {
      unique.set(entry.argIndex, entry);
    });
    const sorted = [...unique.values()].sort((a, b) => a.argIndex - b.argIndex);
    callArgTemps.set(key, sorted);
  });

  return { sitesByExpr, sites, argsTypes, callArgTemps, tempTypeIds };
};
