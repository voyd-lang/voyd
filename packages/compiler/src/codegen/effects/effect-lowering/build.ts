import type {
  CodegenContext,
  HirExprId,
  SymbolId,
  TypeId,
} from "../../context.js";
import { effectsFacade } from "../facade.js";
import type {
  BuildEffectLoweringParams,
  ContinuationCaptureField,
  ContinuationSiteEir,
  EffectLoweringEirResult,
} from "./types.js";
import { analyzeExpr } from "./liveness.js";
import {
  definitionOrderForFunction,
  definitionOrderForHandlerClause,
  definitionOrderForLambda,
  functionParamSymbols,
  handlerClauseParamSymbols,
  lambdaParamSymbols,
  sanitizeIdentifier,
} from "./layout.js";

type TempCaptureKey = string;

const uniqueTempCaptures = (
  captures: readonly {
    key: TempCaptureKey;
    callExprId: HirExprId;
    argIndex: number;
    typeId: TypeId;
  }[]
): readonly {
  key: TempCaptureKey;
  callExprId: HirExprId;
  argIndex: number;
  typeId: TypeId;
}[] =>
  captures
    .slice()
    .sort((a, b) =>
      a.callExprId !== b.callExprId ? a.callExprId - b.callExprId : a.argIndex - b.argIndex
    )
    .filter((capture, index, all) => (index === 0 ? true : all[index - 1]!.key !== capture.key));

const resumeValueTypeIdForSite = ({
  site,
  ctx,
}: {
  site: { kind: "perform" | "call"; exprId: HirExprId; effectSymbol?: SymbolId };
  ctx: CodegenContext;
}): TypeId => {
  const exprType =
    ctx.module.types.getResolvedExprType(site.exprId) ??
    ctx.module.types.getExprType(site.exprId);
  if (site.kind === "perform") {
    if (typeof site.effectSymbol !== "number") {
      throw new Error("perform site missing effect op symbol");
    }
    const signature = ctx.program.functions.getSignature(ctx.moduleId, site.effectSymbol);
    const fallbackType = signature?.returnType ?? ctx.program.primitives.unknown;
    if (typeof exprType !== "number") {
      return fallbackType;
    }
    const desc = ctx.program.types.getTypeDesc(exprType);
    if (desc.kind === "type-param-ref") {
      return fallbackType;
    }
    if (desc.kind === "primitive" && desc.name === "unknown") {
      return fallbackType;
    }
    return exprType;
  }
  return exprType ?? ctx.program.primitives.unknown;
};

const captureFieldsForSite = ({
  liveSymbols,
  params,
  ordering,
  tempCaptures,
  ctx,
}: {
  liveSymbols: ReadonlySet<SymbolId>;
  params: ReadonlySet<SymbolId>;
  ordering: Map<SymbolId, number>;
  tempCaptures: readonly { tempId: number; typeId: TypeId }[];
  ctx: CodegenContext;
}): ContinuationCaptureField[] => {
  const symbolFields = Array.from(liveSymbols)
    .filter((symbol) => params.has(symbol) || ordering.has(symbol))
    .sort((a, b) => (ordering.get(a) ?? 0) - (ordering.get(b) ?? 0))
    .map(
      (symbol): ContinuationCaptureField => ({
        sourceKind: params.has(symbol) ? "param" : "local",
        symbol,
        typeId: ctx.module.types.getValueType(symbol) ?? ctx.program.primitives.unknown,
      })
    );

  const tempFields: ContinuationCaptureField[] = tempCaptures.map((capture) => ({
    sourceKind: "temp",
    tempId: capture.tempId,
    typeId: capture.typeId,
  }));

  return [...tempFields, ...symbolFields];
};

export const buildEffectLoweringEir = ({
  ctx,
  siteCounter,
}: BuildEffectLoweringParams): EffectLoweringEirResult => {
  const sites: ContinuationSiteEir[] = [];
  const sitesByExpr = new Map<HirExprId, ContinuationSiteEir>();
  const callArgTemps = new Map<
    HirExprId,
    { argIndex: number; tempId: number; typeId: TypeId }[]
  >();
  const tempTypeIds = new Map<number, TypeId>();
  const tempIdByKey = new Map<string, number>();
  let tempCounter = 0;

  const ensureTempId = (capture: {
    key: string;
    callExprId: HirExprId;
    argIndex: number;
    typeId: TypeId;
  }): number => {
    const existing = tempIdByKey.get(capture.key);
    if (typeof existing === "number") {
      return existing;
    }
    const next = tempCounter;
    tempCounter += 1;
    tempIdByKey.set(capture.key, next);
    tempTypeIds.set(next, capture.typeId);

    const list = callArgTemps.get(capture.callExprId) ?? [];
    list.push({ argIndex: capture.argIndex, tempId: next, typeId: capture.typeId });
    callArgTemps.set(capture.callExprId, list);
    return next;
  };

  const emitSitesFor = ({
    analysisSites,
    owner,
    contBaseName,
    ordering,
    params,
    handlerAtSite,
  }: {
    analysisSites: readonly {
      kind: "perform" | "call";
      exprId: HirExprId;
      liveAfter: ReadonlySet<SymbolId>;
      effectSymbol?: SymbolId;
      tempCaptures?: readonly {
        key: string;
        callExprId: HirExprId;
        argIndex: number;
        typeId: TypeId;
      }[];
    }[];
    owner: ContinuationSiteEir["owner"];
    contBaseName: string;
    ordering: Map<SymbolId, number>;
    params: ReadonlySet<SymbolId>;
    handlerAtSite: boolean;
  }): void => {
    analysisSites.forEach((site) => {
      const resumeValueTypeId = resumeValueTypeIdForSite({ site, ctx });
      const tempCaptures = uniqueTempCaptures(site.tempCaptures ?? []).map((capture) => ({
        tempId: ensureTempId(capture),
        typeId: capture.typeId,
      }));
      const captureFields = captureFieldsForSite({
        liveSymbols: site.liveAfter,
        params,
        ordering,
        tempCaptures,
        ctx,
      });

      const lowered: ContinuationSiteEir =
        site.kind === "perform"
          ? (() => {
              if (typeof site.effectSymbol !== "number") {
                throw new Error("perform site missing effect op symbol");
              }
              return {
                kind: "perform",
                exprId: site.exprId,
                siteId: siteCounter.current,
                siteOrder: siteCounter.current,
                owner,
                effectSymbol: site.effectSymbol,
                contBaseName,
                handlerAtSite,
                resumeValueTypeId,
                captureFields,
              };
            })()
          : {
              kind: "call",
              exprId: site.exprId,
              siteId: siteCounter.current,
              siteOrder: siteCounter.current,
              owner,
              contBaseName,
              handlerAtSite,
              resumeValueTypeId,
              captureFields,
            };

      siteCounter.current += 1;
      sites.push(lowered);
      sitesByExpr.set(site.exprId, lowered);
    });
  };

  ctx.module.hir.items.forEach((item) => {
    if (item.kind !== "function") return;
    const effectInfo = effectsFacade(ctx).functionAbi(item.symbol);
    if (!effectInfo) return;
    if (!effectInfo.abiEffectful) return;

    const ordering = definitionOrderForFunction(item, ctx);
    const params = functionParamSymbols(item);
    const analysis = analyzeExpr({ exprId: item.body, liveAfter: new Set(), ctx });
    const symbolId = ctx.program.symbols.idOf({ moduleId: ctx.moduleId, symbol: item.symbol });
    const fnName = sanitizeIdentifier(ctx.program.symbols.getName(symbolId) ?? `${item.symbol}`);
    const contBaseName = `__cont_${sanitizeIdentifier(ctx.moduleLabel)}_${fnName}_${item.symbol}`;

    emitSitesFor({
      analysisSites: analysis.sites,
      owner: { kind: "function", symbol: item.symbol },
      contBaseName,
      ordering,
      params,
      handlerAtSite: true,
    });
  });

  ctx.module.hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "lambda") return;
    const lambdaAbi = effectsFacade(ctx).lambdaAbi(expr.id);
    if (!lambdaAbi?.shouldLower) return;

    const ordering = definitionOrderForLambda(expr, ctx);
    const params = lambdaParamSymbols(expr);
    const fnName = `lambda_${expr.id}`;
    const contBaseName = `__cont_${sanitizeIdentifier(ctx.moduleLabel)}_${fnName}_${expr.id}`;
    const analysis = analyzeExpr({ exprId: expr.body, liveAfter: new Set(), ctx });

    emitSitesFor({
      analysisSites: analysis.sites,
      owner: { kind: "lambda", exprId: expr.id },
      contBaseName,
      ordering,
      params,
      handlerAtSite: true,
    });
  });

  ctx.module.hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "effect-handler") return;

    expr.handlers.forEach((clause, clauseIndex) => {
      const ordering = definitionOrderForHandlerClause({ clause, ctx });
      const params = handlerClauseParamSymbols(clause);
      const analysis = analyzeExpr({ exprId: clause.body, liveAfter: new Set(), ctx });
      const fnName = `handler_${expr.id}_${clauseIndex}`;
      const contBaseName = `__cont_${sanitizeIdentifier(ctx.moduleLabel)}_${fnName}`;

      emitSitesFor({
        analysisSites: analysis.sites,
        owner: { kind: "handler-clause", handlerExprId: expr.id, clauseIndex },
        contBaseName,
        ordering,
        params,
        handlerAtSite: true,
      });
    });
  });

  callArgTemps.forEach((value, key) => {
    const unique = new Map<number, { argIndex: number; tempId: number; typeId: TypeId }>();
    value.forEach((entry) => unique.set(entry.argIndex, entry));
    const sorted = [...unique.values()].sort((a, b) => a.argIndex - b.argIndex);
    callArgTemps.set(key, sorted);
  });

  return { sitesByExpr, sites, callArgTemps, tempTypeIds };
};
