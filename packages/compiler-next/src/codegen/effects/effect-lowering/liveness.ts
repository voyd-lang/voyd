import type {
  CodegenContext,
  HirExprId,
  HirPattern,
  HirStmtId,
  SymbolId,
  TypeId,
} from "../../context.js";
import { effectsFacade } from "../facade.js";

export interface TempCaptureDraft {
  key: string;
  callExprId: HirExprId;
  argIndex: number;
  typeId: TypeId;
}

export interface SiteDraft {
  kind: "perform" | "call";
  exprId: HirExprId;
  liveAfter: ReadonlySet<SymbolId>;
  evalOrder: readonly HirExprId[];
  effectSymbol?: SymbolId;
  tempCaptures?: TempCaptureDraft[];
}

export type LiveResult = {
  live: Set<SymbolId>;
  sites: SiteDraft[];
};

const cloneLive = (set: ReadonlySet<SymbolId>): Set<SymbolId> => new Set(set);

const setsEqual = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean => {
  if (a.size !== b.size) return false;
  for (const value of a) {
    if (!b.has(value)) return false;
  }
  return true;
};

const mergeLive = (...sets: ReadonlySet<SymbolId>[]): Set<SymbolId> => {
  const merged = new Set<SymbolId>();
  sets.forEach((entry) => entry.forEach((symbol) => merged.add(symbol)));
  return merged;
};

const mergeSiteResults = (...results: LiveResult[]): LiveResult => ({
  live: mergeLive(...results.map((res) => res.live)),
  sites: results.flatMap((res) => res.sites),
});

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

const collectPatternSymbols = (pattern: HirPattern, into: Set<SymbolId>): void => {
  switch (pattern.kind) {
    case "identifier":
      into.add(pattern.symbol);
      return;
    case "destructure":
      pattern.fields.forEach((field) => collectPatternSymbols(field.pattern, into));
      if (pattern.spread) {
        collectPatternSymbols(pattern.spread, into);
      }
      return;
    case "tuple":
      pattern.elements.forEach((element) => collectPatternSymbols(element, into));
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
  visitExpr,
}: {
  stmtId: HirStmtId;
  liveAfter: ReadonlySet<SymbolId>;
  ctx: CodegenContext;
  visitExpr: (params: {
    exprId: HirExprId;
    liveAfter: ReadonlySet<SymbolId>;
    ctx: CodegenContext;
  }) => LiveResult;
}): LiveResult => {
  const stmt = ctx.hir.statements.get(stmtId);
  if (!stmt) {
    throw new Error(`codegen missing HirStatement ${stmtId}`);
  }

  switch (stmt.kind) {
    case "expr-stmt": {
      const res = visitExpr({ exprId: stmt.expr, liveAfter, ctx });
      return { live: mergeLive(liveAfter, res.live), sites: res.sites };
    }
    case "return": {
      if (typeof stmt.value !== "number") {
        return { live: new Set(), sites: [] };
      }
      return visitExpr({ exprId: stmt.value, liveAfter: new Set(), ctx });
    }
    case "let": {
      const res = visitExpr({ exprId: stmt.initializer, liveAfter, ctx });
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
  visitExpr,
}: {
  exprId: HirExprId;
  liveAfter: ReadonlySet<SymbolId>;
  ctx: CodegenContext;
  visitExpr: (params: {
    exprId: HirExprId;
    liveAfter: ReadonlySet<SymbolId>;
    ctx: CodegenContext;
  }) => LiveResult;
}): LiveResult => {
  const expr = ctx.hir.expressions.get(exprId);
  if (!expr || expr.exprKind !== "block") {
    throw new Error("analyzeBlock expects a block expression");
  }

  let live = cloneLive(liveAfter);
  const sites: SiteDraft[] = [];

  if (typeof expr.value === "number") {
    const valueRes = visitExpr({ exprId: expr.value, liveAfter, ctx });
    live = mergeLive(live, valueRes.live);
    sites.push(...valueRes.sites);
  }

  [...expr.statements].reverse().forEach((stmtId) => {
    const res = analyzeStatement({ stmtId, liveAfter: live, ctx, visitExpr });
    live = res.live;
    sites.push(...res.sites);
  });

  return { live, sites };
};

export const analyzeExpr = ({
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
      return { live: mergeLive(liveAfter, new Set([expr.symbol])), sites: [] };
    case "literal":
    case "overload-set":
    case "continue":
      return { live: cloneLive(liveAfter), sites: [] };
    case "break": {
      if (typeof expr.value !== "number") {
        return { live: cloneLive(liveAfter), sites: [] };
      }
      const res = analyzeExpr({ exprId: expr.value, liveAfter, ctx });
      return { live: mergeLive(liveAfter, res.live), sites: res.sites };
    }
    case "tuple": {
      const results = expr.elements.map((element) =>
        analyzeExpr({ exprId: element, liveAfter, ctx })
      );
      return mergeSiteResults(...results, { live: cloneLive(liveAfter), sites: [] });
    }
    case "block":
      return analyzeBlock({ exprId, liveAfter, ctx, visitExpr: analyzeExpr });
    case "loop":
      return analyzeExpr({ exprId: expr.body, liveAfter, ctx });
    case "while": {
      let loopHeadLive = cloneLive(liveAfter);

      let bodyRes: LiveResult = { live: new Set(), sites: [] };
      let condRes: LiveResult = { live: new Set(), sites: [] };

      for (let iteration = 0; iteration < 32; iteration += 1) {
        bodyRes = analyzeExpr({ exprId: expr.body, liveAfter: loopHeadLive, ctx });
        const liveAfterCondition = mergeLive(liveAfter, bodyRes.live);
        condRes = analyzeExpr({
          exprId: expr.condition,
          liveAfter: liveAfterCondition,
          ctx,
        });

        if (setsEqual(condRes.live, loopHeadLive)) {
          return { live: condRes.live, sites: [...condRes.sites, ...bodyRes.sites] };
        }

        loopHeadLive = condRes.live;
      }

      bodyRes = analyzeExpr({ exprId: expr.body, liveAfter: loopHeadLive, ctx });
      condRes = analyzeExpr({
        exprId: expr.condition,
        liveAfter: mergeLive(liveAfter, bodyRes.live),
        ctx,
      });
      return { live: condRes.live, sites: [...condRes.sites, ...bodyRes.sites] };
    }
    case "cond":
    case "if": {
      const branchResults = expr.branches.map((branch) => {
        const valueRes = analyzeExpr({ exprId: branch.value, liveAfter, ctx });
        const condRes = analyzeExpr({
          exprId: branch.condition,
          liveAfter: mergeLive(liveAfter, valueRes.live),
          ctx,
        });
        return mergeSiteResults(condRes, valueRes);
      });
      const defaultRes =
        typeof expr.defaultBranch === "number"
          ? analyzeExpr({ exprId: expr.defaultBranch, liveAfter, ctx })
          : { live: cloneLive(liveAfter), sites: [] };
      return mergeSiteResults(...branchResults, defaultRes);
    }
    case "match": {
      const discriminantRes = analyzeExpr({ exprId: expr.discriminant, liveAfter, ctx });
      const armResults = expr.arms.map((arm) => {
        const guardRes =
          typeof arm.guard === "number"
            ? analyzeExpr({ exprId: arm.guard, liveAfter, ctx })
            : { live: cloneLive(liveAfter), sites: [] };
        const valueRes = analyzeExpr({ exprId: arm.value, liveAfter, ctx });
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
      const res = analyzeExpr({ exprId: expr.target, liveAfter, ctx });
      return { live: mergeLive(liveAfter, res.live), sites: res.sites };
    }
    case "assign": {
      const targetRes =
        typeof expr.target === "number"
          ? analyzeExpr({ exprId: expr.target, liveAfter, ctx })
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
      return { live, sites: [...targetRes.sites, ...valueRes.sites] };
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
    case "call": {
      const callee = ctx.hir.expressions.get(expr.callee);
      const argResults: LiveResult[] = new Array(expr.args.length);
      let cursor = cloneLive(liveAfter);
      for (let index = expr.args.length - 1; index >= 0; index -= 1) {
        const arg = expr.args[index]!;
        const res = analyzeExpr({ exprId: arg.expr, liveAfter: cursor, ctx });
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
      const kind = effectsFacade(ctx).callKind(expr.id);
      if (kind === "perform") {
        const calleeSymbol =
          callee && callee.exprKind === "identifier" ? callee.symbol : undefined;
        if (typeof calleeSymbol !== "number") {
          throw new Error("perform site missing callee symbol");
        }
        const site: SiteDraft = {
          kind: "perform",
          exprId: expr.id,
          liveAfter,
          evalOrder: expr.args.map((arg) => arg.expr),
          effectSymbol: calleeSymbol,
        };
        return { live: merged.live, sites: [...merged.sites, site] };
      }

      if (kind === "effectful-call") {
        const site: SiteDraft = {
          kind: "call",
          exprId: expr.id,
          liveAfter,
          evalOrder: expr.args.map((arg) => arg.expr),
        };
        return { live: merged.live, sites: [...merged.sites, site] };
      }

      return merged;
    }
  }
};
