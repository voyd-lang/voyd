import binaryen from "binaryen";
import {
  defineStructType,
  modBinaryenTypeToHeapType,
} from "@voyd/lib/binaryen-gc/index.js";
import type {
  CodegenContext,
  HirExprId,
  SymbolId,
  TypeId,
} from "../../context.js";
import { wasmTypeFor } from "../../types.js";
import { getEffectOpIds } from "../op-ids.js";
import { effectsFacade } from "../facade.js";
import type {
  BuildEffectLoweringParams,
  ContinuationEnvField,
  ContinuationSite,
  EffectLoweringResult,
} from "./types.js";
import { analyzeExpr } from "./liveness.js";
import {
  definitionOrderForFunction,
  definitionOrderForHandlerClause,
  definitionOrderForLambda,
  envFieldsFor,
  functionParamSymbols,
  handlerClauseParamSymbols,
  lambdaParamSymbols,
  sanitizeIdentifier,
  shouldLowerLambda,
  ensureArgsType,
} from "./layout.js";
import {
  handlerClauseContinuationTempId,
  handlerClauseTailGuardTempId,
} from "./handler-clause-temp-ids.js";

type TempCaptureKey = string;

const uniqueTempCaptures = (
  captures: readonly { key: TempCaptureKey; callExprId: HirExprId; argIndex: number; typeId: TypeId }[]
): readonly { key: TempCaptureKey; callExprId: HirExprId; argIndex: number; typeId: TypeId }[] =>
  captures
    .slice()
    .sort((a, b) => (a.callExprId !== b.callExprId ? a.callExprId - b.callExprId : a.argIndex - b.argIndex))
    .filter((capture, index, all) => (index === 0 ? true : all[index - 1]!.key !== capture.key));

const resumeValueTypeIdForSite = ({
  site,
  ctx,
}: {
  site: { kind: "perform" | "call"; exprId: HirExprId; effectSymbol?: SymbolId };
  ctx: CodegenContext;
}): TypeId => {
  const exprType =
    ctx.typing.resolvedExprTypes.get(site.exprId) ??
    ctx.typing.table.getExprType(site.exprId);
  if (site.kind === "perform") {
    if (typeof site.effectSymbol !== "number") {
      throw new Error("perform site missing effect op symbol");
    }
    if (typeof exprType === "number") {
      return exprType;
    }
    const signature = ctx.typing.functions.getSignature(site.effectSymbol);
    return signature?.returnType ?? ctx.typing.primitives.unknown;
  }
  return exprType ?? ctx.typing.primitives.unknown;
};

const baseEnvFields = (ctx: CodegenContext): ContinuationEnvField[] => [
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
];

const handlerClauseBaseTemps = ({
  owner,
  ctx,
}: {
  owner: ContinuationSite["owner"];
  ctx: CodegenContext;
}): ContinuationEnvField[] => {
  if (owner.kind !== "handler-clause") return [];
  return [
    {
      name: "clause_cont",
      wasmType: ctx.effectsRuntime.continuationType,
      typeId: ctx.typing.primitives.unknown,
      sourceKind: "local",
      tempId: handlerClauseContinuationTempId({
        handlerExprId: owner.handlerExprId,
        clauseIndex: owner.clauseIndex,
      }),
    },
    {
      name: "clause_tail_guard",
      wasmType: ctx.effectsRuntime.tailGuardType,
      typeId: ctx.typing.primitives.unknown,
      sourceKind: "local",
      tempId: handlerClauseTailGuardTempId({
        handlerExprId: owner.handlerExprId,
        clauseIndex: owner.clauseIndex,
      }),
    },
  ];
};

export const buildEffectLowering = ({
  ctx,
  siteCounter,
}: BuildEffectLoweringParams): EffectLoweringResult => {
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

  const ensureTempId = (capture: { key: string; callExprId: HirExprId; argIndex: number; typeId: TypeId }): number => {
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
    contFnName,
    ordering,
    params,
    handlerAtSite,
    fnNameForEnv,
  }: {
    analysisSites: readonly {
      kind: "perform" | "call";
      exprId: HirExprId;
      liveAfter: ReadonlySet<SymbolId>;
      effectSymbol?: SymbolId;
      tempCaptures?: readonly { key: string; callExprId: HirExprId; argIndex: number; typeId: TypeId }[];
    }[];
    owner: ContinuationSite["owner"];
    contFnName: string;
    ordering: Map<SymbolId, number>;
    params: ReadonlySet<SymbolId>;
    handlerAtSite: boolean;
    fnNameForEnv: string;
  }): void => {
    analysisSites.forEach((site) => {
      const resumeValueTypeId = resumeValueTypeIdForSite({ site, ctx });
      const tempCaptures = uniqueTempCaptures(site.tempCaptures ?? []);
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
      const clauseTemps = handlerClauseBaseTemps({ owner, ctx });
      const capturedFields = envFieldsFor({
        liveSymbols: site.liveAfter,
        params,
        ordering,
        ctx,
      });

      const envFields: ContinuationEnvField[] = [
        ...baseEnvFields(ctx),
        ...clauseTemps,
        ...tempFields,
        ...capturedFields,
      ];
      const envType = defineStructType(ctx.mod, {
        name: `voydContEnv_${sanitizeIdentifier(ctx.moduleLabel)}_${fnNameForEnv}_${siteCounter.current}`,
        fields: envFields.map((field) => ({ name: field.name, type: field.wasmType, mutable: false })),
        supertype: baseHeapType,
        final: true,
      });

      const performMeta =
        site.kind === "perform"
          ? (() => {
              if (typeof site.effectSymbol !== "number") {
                throw new Error("perform site missing effect op symbol");
              }
              const { effectId, opId, resumeKind, effectSymbol } = getEffectOpIds(site.effectSymbol, ctx);
              const signature = ctx.typing.functions.getSignature(site.effectSymbol);
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
              owner,
              effectSymbol: performMeta.effectSymbol,
              effectId: performMeta.effectId,
              opId: performMeta.opId,
              resumeKind: performMeta.resumeKind,
              contFnName,
              baseEnvType,
              envType,
              envFields,
              handlerAtSite,
              resumeValueTypeId,
              argsType: performMeta.argsType,
            }
          : {
              kind: "call",
              exprId: site.exprId,
              siteId: siteCounter.current,
              siteOrder: siteCounter.current,
              owner,
              contFnName,
              baseEnvType,
              envType,
              envFields,
              handlerAtSite,
              resumeValueTypeId,
            };

      siteCounter.current += 1;
      sites.push(lowered);
      sitesByExpr.set(site.exprId, lowered);
    });
  };

  ctx.hir.items.forEach((item) => {
    if (item.kind !== "function") return;
    const effectInfo = effectsFacade(ctx).functionAbi(item.symbol);
    if (!effectInfo) return;
    if (!effectInfo.abiEffectful) return;

    const ordering = definitionOrderForFunction(item, ctx);
    const params = functionParamSymbols(item);
    const analysis = analyzeExpr({ exprId: item.body, liveAfter: new Set(), ctx });
    const fnName = sanitizeIdentifier(ctx.symbolTable.getSymbol(item.symbol).name);
    const contFnName = `__cont_${sanitizeIdentifier(ctx.moduleLabel)}_${fnName}_${item.symbol}`;

    emitSitesFor({
      analysisSites: analysis.sites,
      owner: { kind: "function", symbol: item.symbol },
      contFnName,
      ordering,
      params,
      handlerAtSite: true,
      fnNameForEnv: fnName,
    });
  });

  ctx.hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "lambda") return;
    if (!shouldLowerLambda(expr, ctx)) return;

    const ordering = definitionOrderForLambda(expr, ctx);
    const params = lambdaParamSymbols(expr);
    const fnName = `lambda_${expr.id}`;
    const contFnName = `__cont_${sanitizeIdentifier(ctx.moduleLabel)}_${fnName}_${expr.id}`;
    const analysis = analyzeExpr({ exprId: expr.body, liveAfter: new Set(), ctx });

    emitSitesFor({
      analysisSites: analysis.sites,
      owner: { kind: "lambda", exprId: expr.id },
      contFnName,
      ordering,
      params,
      handlerAtSite: true,
      fnNameForEnv: fnName,
    });
  });

  ctx.hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "effect-handler") return;

    expr.handlers.forEach((clause, clauseIndex) => {
      const ordering = definitionOrderForHandlerClause({ clause, ctx });
      const params = handlerClauseParamSymbols(clause);
      const analysis = analyzeExpr({ exprId: clause.body, liveAfter: new Set(), ctx });
      const fnName = `handler_${expr.id}_${clauseIndex}`;
      const contFnName = `__cont_${sanitizeIdentifier(ctx.moduleLabel)}_${fnName}`;

      emitSitesFor({
        analysisSites: analysis.sites,
        owner: { kind: "handler-clause", handlerExprId: expr.id, clauseIndex },
        contFnName,
        ordering,
        params,
        handlerAtSite: true,
        fnNameForEnv: fnName,
      });
    });
  });

  callArgTemps.forEach((value, key) => {
    const unique = new Map<number, { argIndex: number; tempId: number; typeId: TypeId }>();
    value.forEach((entry) => unique.set(entry.argIndex, entry));
    const sorted = [...unique.values()].sort((a, b) => a.argIndex - b.argIndex);
    callArgTemps.set(key, sorted);
  });

  return { sitesByExpr, sites, argsTypes, callArgTemps, tempTypeIds };
};
