import binaryen from "binaryen";
import {
  defineStructType,
  modBinaryenTypeToHeapType,
} from "@voyd/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  HirExprId,
  HirFunction,
  HirPattern,
  HirStmtId,
  SymbolId,
  TypeId,
} from "../context.js";
import { wasmTypeFor } from "../types.js";
import { RESUME_KIND, type ResumeKind } from "./runtime-abi.js";

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

export interface EffectPerformSite {
  exprId: HirExprId;
  siteId: number;
  siteOrder: number;
  functionSymbol: SymbolId;
  effectSymbol: SymbolId;
  effectId: number;
  opId: number;
  resumeKind: ResumeKind;
  contFnName: string;
  contRefType?: binaryen.Type;
  baseEnvType: binaryen.Type;
  envType: binaryen.Type;
  envFields: readonly ContinuationEnvField[];
  handlerAtSite: boolean;
  postBlockLabel: string;
  evalOrder: readonly HirExprId[];
  resumeValueTypeId: TypeId;
  resumeValueType: binaryen.Type;
  argsType?: binaryen.Type;
}

export interface EffectLoweringResult {
  sitesByExpr: Map<HirExprId, EffectPerformSite>;
  sites: readonly EffectPerformSite[];
  argsTypes: Map<SymbolId, binaryen.Type>;
}

type SiteCounter = { current: number };

interface SiteDraft {
  exprId: HirExprId;
  liveAfter: ReadonlySet<SymbolId>;
  evalOrder: readonly HirExprId[];
  effectSymbol: SymbolId;
}

type LiveResult = {
  live: Set<SymbolId>;
  sites: SiteDraft[];
};

export const effectOpIds = (
  symbol: SymbolId,
  ctx: CodegenContext
): {
  effectId: number;
  opId: number;
  resumeKind: ResumeKind;
  effectSymbol: SymbolId;
} => {
  for (let effectId = 0; effectId < ctx.binding.effects.length; effectId += 1) {
    const effect = ctx.binding.effects[effectId]!;
    const opIndex = effect.operations.findIndex((op) => op.symbol === symbol);
    if (opIndex < 0) continue;
    const op = effect.operations[opIndex]!;
    const resumeKind =
      op.resumable === "tail" ? RESUME_KIND.tail : RESUME_KIND.resume;
    return { effectId, opId: opIndex, resumeKind, effectSymbol: effect.symbol };
  }
  throw new Error(`codegen missing effect metadata for op ${symbol}`);
};

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

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
      const argResults: LiveResult[] = [];
      let cursor = cloneLive(liveAfter);
      [...expr.args].reverse().forEach((arg) => {
        const res = analyzeExpr({
          exprId: arg.expr,
          liveAfter: cursor,
          ctx,
        });
        cursor = mergeLive(cursor, res.live);
        argResults.push(res);
      });
      const calleeResult =
        callee && callee.exprKind !== "identifier"
          ? analyzeExpr({ exprId: expr.callee, liveAfter: cursor, ctx })
          : { live: cursor, sites: [] };
      const merged = mergeSiteResults(...argResults, calleeResult);
      if (
        callee &&
        callee.exprKind === "identifier" &&
        ctx.symbolTable.getSymbol(callee.symbol).kind === "effect-op"
      ) {
        const site: SiteDraft = {
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
    case "effect-handler":
      return { live: cloneLive(liveAfter), sites: [] };
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
  const add = (symbol: SymbolId): void => {
    if (!order.has(symbol)) {
      order.set(symbol, order.size);
    }
  };
  const visitPattern = (pattern: HirPattern): void => {
    switch (pattern.kind) {
      case "identifier":
        add(pattern.symbol);
        return;
      case "destructure":
        pattern.fields.forEach((field) => visitPattern(field.pattern));
        if (pattern.spread) {
          visitPattern(pattern.spread);
        }
        return;
      case "tuple":
        pattern.elements.forEach((element) => visitPattern(element));
        return;
      case "type":
        if (pattern.binding) {
          visitPattern(pattern.binding);
        }
        return;
      case "wildcard":
        return;
    }
  };

  fn.parameters.forEach((param) => visitPattern(param.pattern));

  const walkExpr = (exprId: HirExprId): void => {
    const expr = ctx.hir.expressions.get(exprId);
    if (!expr) return;
    switch (expr.exprKind) {
      case "block":
        expr.statements.forEach((stmtId) => {
          const stmt = ctx.hir.statements.get(stmtId);
          if (!stmt) return;
          if (stmt.kind === "let") {
            visitPattern(stmt.pattern);
            walkExpr(stmt.initializer);
            return;
          }
          if (stmt.kind === "expr-stmt") {
            walkExpr(stmt.expr);
          }
          if (stmt.kind === "return" && typeof stmt.value === "number") {
            walkExpr(stmt.value);
          }
        });
        if (typeof expr.value === "number") {
          walkExpr(expr.value);
        }
        return;
      case "call":
        walkExpr(expr.callee);
        expr.args.forEach((arg) => walkExpr(arg.expr));
        return;
      case "tuple":
        expr.elements.forEach((element) => walkExpr(element));
        return;
      case "loop":
      case "while":
        walkExpr(expr.body);
        if (expr.exprKind === "while") {
          walkExpr(expr.condition);
        }
        return;
      case "cond":
      case "if":
        expr.branches.forEach((branch) => {
          walkExpr(branch.condition);
          walkExpr(branch.value);
        });
        if (typeof expr.defaultBranch === "number") {
          walkExpr(expr.defaultBranch);
        }
        return;
      case "match":
        walkExpr(expr.discriminant);
        expr.arms.forEach((arm) => {
          if (typeof arm.guard === "number") {
            walkExpr(arm.guard);
          }
          walkExpr(arm.value);
        });
        return;
      case "object-literal":
        expr.entries.forEach((entry) => walkExpr(entry.value));
        return;
      case "field-access":
        walkExpr(expr.target);
        return;
      case "assign":
        if (typeof expr.target === "number") {
          walkExpr(expr.target);
        }
        walkExpr(expr.value);
        if (expr.pattern) {
          visitPattern(expr.pattern);
        }
        return;
      case "identifier":
      case "literal":
      case "lambda":
      case "effect-handler":
      case "overload-set":
      case "continue":
      case "break":
        return;
    }
  };

  walkExpr(fn.body);
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
  const sites: EffectPerformSite[] = [];
  const sitesByExpr = new Map<HirExprId, EffectPerformSite>();
  const argsTypeCache = new Map<SymbolId, binaryen.Type>();
  const argsTypes = new Map<SymbolId, binaryen.Type>();
  const baseEnvTypes = new Map<SymbolId, binaryen.Type>();

  const ensureBaseEnvType = (fnSymbol: SymbolId): binaryen.Type => {
    const cached = baseEnvTypes.get(fnSymbol);
    if (cached) return cached;
    const fnName = sanitize(ctx.symbolTable.getSymbol(fnSymbol).name);
    const baseType = defineStructType(ctx.mod, {
      name: `voydContEnvBase_${sanitize(ctx.moduleLabel)}_${fnName}_${fnSymbol}`,
      fields: [
        { name: "site", type: binaryen.i32, mutable: false },
        {
          name: "handler",
          type: ctx.effectsRuntime.handlerFrameType,
          mutable: false,
        },
      ],
      final: false,
    });
    baseEnvTypes.set(fnSymbol, baseType);
    return baseType;
  };

  ctx.hir.items.forEach((item) => {
    if (item.kind !== "function") return;
    const effectInfo = ctx.effectMir.functions.get(item.symbol);
    if (!effectInfo || effectInfo.pure) return;

    const order = definitionOrder(item, ctx);
    const params = paramSymbolSet(item);
    const analysis = analyzeExpr({
      exprId: item.body,
      liveAfter: new Set(),
      ctx,
    });
    const baseEnvType = ensureBaseEnvType(item.symbol);
    const baseHeapType = modBinaryenTypeToHeapType(ctx.mod, baseEnvType);
    const fnName = sanitize(ctx.symbolTable.getSymbol(item.symbol).name);

    analysis.sites.forEach((site) => {
      const { effectId, opId, resumeKind, effectSymbol } = effectOpIds(
        site.effectSymbol,
        ctx
      );
      const signature = ctx.typing.functions.getSignature(site.effectSymbol);
      const resumeValueTypeId =
        signature?.returnType ?? ctx.typing.primitives.unknown;
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
      const resumeValueType = wasmTypeFor(resumeValueTypeId, ctx);
      const resumeKey =
        resumeValueType === binaryen.none
          ? "void"
          : resumeValueType === binaryen.i32
            ? "i32"
            : `t${resumeValueType}`;
      const contFnName = `__cont_${sanitize(ctx.moduleLabel)}_${fnName}_${item.symbol}_${resumeKey}`;
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
      const lowered: EffectPerformSite = {
        exprId: site.exprId,
        siteId: siteCounter.current,
        siteOrder: siteCounter.current,
        functionSymbol: item.symbol,
        effectSymbol,
        effectId,
        opId,
        resumeKind,
        contFnName,
        baseEnvType,
        envType,
        envFields,
        handlerAtSite: true,
        postBlockLabel: `post_${siteCounter.current}`,
        evalOrder: site.evalOrder,
        resumeValueTypeId,
        resumeValueType,
        argsType,
      };
      siteCounter.current += 1;
      sites.push(lowered);
      sitesByExpr.set(site.exprId, lowered);
    });
  });

  return { sitesByExpr, sites, argsTypes };
};
