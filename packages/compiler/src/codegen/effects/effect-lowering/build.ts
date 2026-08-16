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
import { getOptimizedParamAbiKind } from "../../types.js";
import { analyzeExpr } from "./liveness.js";
import { walkHirExpression } from "../../hir-walk.js";
import {
  definitionOrderForFunction,
  definitionOrderForHandlerClause,
  definitionOrderForLambda,
  functionParamSymbols,
  handlerClauseParamSymbols,
  lambdaParamSymbols,
  sanitizeIdentifier,
} from "./layout.js";
import { wasmSymbolName } from "../../symbol-names.js";
import {
  collectGeneratedRangeLoopShapes,
  describeGeneratedRangeLoopState,
} from "../../generated-state.js";

type TempCaptureKey = string;

const uniqueTempCaptures = (
  captures: readonly {
    key: TempCaptureKey;
    callExprId: HirExprId;
    argIndex: number;
    typeId: TypeId;
  }[],
): readonly {
  key: TempCaptureKey;
  callExprId: HirExprId;
  argIndex: number;
  typeId: TypeId;
}[] =>
  captures
    .slice()
    .sort((a, b) =>
      a.callExprId !== b.callExprId
        ? a.callExprId - b.callExprId
        : a.argIndex - b.argIndex,
    )
    .filter((capture, index, all) =>
      index === 0 ? true : all[index - 1]!.key !== capture.key,
    );

const resumeValueTypeIdForSite = ({
  site,
  ctx,
}: {
  site: {
    kind: "perform" | "call";
    exprId: HirExprId;
    effectSymbol?: SymbolId;
  };
  ctx: CodegenContext;
}): TypeId => {
  const exprType =
    ctx.module.types.getResolvedExprType(site.exprId) ??
    ctx.module.types.getExprType(site.exprId);
  if (site.kind === "perform") {
    if (typeof site.effectSymbol !== "number") {
      throw new Error("perform site missing effect op symbol");
    }
    const signature = ctx.program.functions.getSignature(
      ctx.moduleId,
      site.effectSymbol,
    );
    const fallbackType =
      signature?.returnType ?? ctx.program.primitives.unknown;
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
  symbolTypes,
  ctx,
}: {
  liveSymbols: ReadonlySet<SymbolId>;
  params: ReadonlySet<SymbolId>;
  ordering: Map<SymbolId, number>;
  tempCaptures: readonly { tempId: number; typeId: TypeId }[];
  symbolTypes: ReadonlyMap<SymbolId, TypeId>;
  ctx: CodegenContext;
}): ContinuationCaptureField[] => {
  const symbolFields = Array.from(liveSymbols)
    .filter((symbol) => params.has(symbol) || ordering.has(symbol))
    .sort((a, b) => (ordering.get(a) ?? 0) - (ordering.get(b) ?? 0))
    .map(
      (symbol): ContinuationCaptureField => ({
        sourceKind: params.has(symbol) ? "param" : "local",
        symbol,
        typeId:
          symbolTypes.get(symbol) ??
          ctx.module.types.getValueType(symbol) ??
          ctx.program.primitives.unknown,
        storageRef: ctx.module.mutableStorageSymbols.has(symbol),
        bindingKind: ctx.module.bindingKinds.get(symbol),
      }),
    );

  const tempFields: ContinuationCaptureField[] = tempCaptures.map(
    (capture) => ({
      sourceKind: "temp",
      tempId: capture.tempId,
      typeId: capture.typeId,
    }),
  );

  return [...tempFields, ...symbolFields];
};

const collectIdentifierSymbolTypes = ({
  exprIds,
  ctx,
}: {
  exprIds: readonly HirExprId[];
  ctx: CodegenContext;
}): Map<SymbolId, TypeId> => {
  const symbolTypes = new Map<SymbolId, TypeId>();
  exprIds.forEach((exprId) =>
    walkHirExpression({
      exprId,
      ctx,
      visitLambdaBodies: false,
      visitor: {
        onExpr: (id, expr) => {
          const setType = (symbol: SymbolId, typeId?: TypeId): void => {
            const resolvedTypeId =
              ctx.module.types.getValueType(symbol) ?? typeId;
            if (typeof resolvedTypeId !== "number") return;
            const existing = symbolTypes.get(symbol);
            if (
              typeof existing === "number" &&
              existing !== ctx.program.primitives.unknown
            ) {
              return;
            }
            symbolTypes.set(symbol, resolvedTypeId);
          };

          if (expr.exprKind === "lambda") {
            expr.captures.forEach((capture) => setType(capture.symbol));
            return;
          }
          if (expr.exprKind !== "identifier") return;
          setType(
            expr.symbol,
            ctx.module.types.getResolvedExprType(id) ??
              ctx.module.types.getExprType(id),
          );
        },
      },
    }),
  );
  return symbolTypes;
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
  const defaultParamTemps = new Map<
    SymbolId,
    {
      tempId: number;
      presenceTempId: number;
      typeId: TypeId;
      storageRef: boolean;
      bindingKind?: import("../../../semantics/hir/index.js").HirBindingKind;
    }
  >();
  const generatedStatesByStatement = new Map<
    number,
    import("../../generated-state.js").CompilerGeneratedState
  >();
  const tempIdByKey = new Map<string, number>();
  let tempCounter = 0;

  const allocateTempId = ({
    key,
    typeId,
  }: {
    key: string;
    typeId: TypeId;
  }): number => {
    const existing = tempIdByKey.get(key);
    if (typeof existing === "number") {
      return existing;
    }
    const next = tempCounter;
    tempCounter += 1;
    tempIdByKey.set(key, next);
    tempTypeIds.set(next, typeId);
    return next;
  };

  const ensureTempId = (capture: {
    key: string;
    callExprId: HirExprId;
    argIndex: number;
    typeId: TypeId;
  }): number => {
    const next = allocateTempId(capture);

    const list = callArgTemps.get(capture.callExprId) ?? [];
    list.push({
      argIndex: capture.argIndex,
      tempId: next,
      typeId: capture.typeId,
    });
    callArgTemps.set(capture.callExprId, list);
    return next;
  };

  const appendExtraCaptureFields = ({
    siteExprId,
    fields,
    into,
  }: {
    siteExprId: HirExprId;
    fields: readonly ContinuationCaptureField[];
    into: Map<HirExprId, readonly ContinuationCaptureField[]>;
  }): void => {
    const existing = into.get(siteExprId) ?? [];
    const tempIds = new Set(existing.map((field) => field.tempId));
    into.set(siteExprId, [
      ...existing,
      ...fields.filter(
        (field) =>
          typeof field.tempId !== "number" || !tempIds.has(field.tempId),
      ),
    ]);
  };

  const addGeneratedStateCaptures = ({
    rootExprId,
    analysisSites,
    extraCaptureFieldsBySite,
    excludedSymbolsBySite,
    excludedTempOwnersBySite,
  }: {
    rootExprId: HirExprId;
    analysisSites: readonly { exprId: HirExprId }[];
    extraCaptureFieldsBySite: Map<
      HirExprId,
      readonly ContinuationCaptureField[]
    >;
    excludedSymbolsBySite: Map<HirExprId, ReadonlySet<SymbolId>>;
    excludedTempOwnersBySite: Map<HirExprId, ReadonlySet<HirExprId>>;
  }): void => {
    const siteExprIds = new Set(analysisSites.map((site) => site.exprId));
    collectGeneratedRangeLoopShapes({ rootExprId, ctx }).forEach((shape) => {
      const state = describeGeneratedRangeLoopState({
        shape,
        i32TypeId: ctx.program.primitives.i32,
        allocateTempId: (fieldName, typeId) =>
          allocateTempId({
            key: `generatedState:range:${shape.statementId}:${fieldName}`,
            typeId,
          }),
      });
      generatedStatesByStatement.set(shape.statementId, state);
      const fieldsByName = new Map(
        state.fields.map((field) => [field.name, field] as const),
      );
      state.resumeRegions.forEach((region) => {
        const regionSiteExprIds = new Set<HirExprId>();
        walkHirExpression({
          exprId: region.exprId,
          ctx,
          visitLambdaBodies: false,
          visitor: {
            onExpr: (exprId) => {
              if (siteExprIds.has(exprId)) regionSiteExprIds.add(exprId);
            },
          },
        });
        const captureFields = region.captureFields.map((fieldName) => {
          const field = fieldsByName.get(fieldName);
          if (!field) {
            throw new Error(
              `generated state region references missing field ${fieldName}`,
            );
          }
          return {
            sourceKind: "temp" as const,
            tempId: field.tempId,
            typeId: field.typeId,
          };
        });
        regionSiteExprIds.forEach((siteExprId) => {
          appendExtraCaptureFields({
            siteExprId,
            fields: captureFields,
            into: extraCaptureFieldsBySite,
          });
          excludedSymbolsBySite.set(
            siteExprId,
            new Set([
              ...(excludedSymbolsBySite.get(siteExprId) ?? []),
              ...region.replacedSymbols,
            ]),
          );
          excludedTempOwnersBySite.set(
            siteExprId,
            new Set([
              ...(excludedTempOwnersBySite.get(siteExprId) ?? []),
              ...region.replacedTempOwners,
            ]),
          );
        });
      });
    });
  };

  const emitSitesFor = ({
    analysisSites,
    owner,
    contBaseName,
    ordering,
    params,
    handlerAtSite,
    symbolTypes,
    extraCaptureFieldsBySite = new Map(),
    excludedSymbolsBySite = new Map(),
    excludedTempOwnersBySite = new Map(),
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
    symbolTypes: ReadonlyMap<SymbolId, TypeId>;
    extraCaptureFieldsBySite?: ReadonlyMap<
      HirExprId,
      readonly ContinuationCaptureField[]
    >;
    excludedSymbolsBySite?: ReadonlyMap<HirExprId, ReadonlySet<SymbolId>>;
    excludedTempOwnersBySite?: ReadonlyMap<HirExprId, ReadonlySet<HirExprId>>;
  }): void => {
    analysisSites.forEach((site) => {
      const resumeValueTypeId = resumeValueTypeIdForSite({ site, ctx });
      const excludedTempOwners = excludedTempOwnersBySite.get(site.exprId);
      const tempCaptures = uniqueTempCaptures(
        (site.tempCaptures ?? []).filter(
          (capture) => !excludedTempOwners?.has(capture.callExprId),
        ),
      ).map((capture) => ({
        tempId: ensureTempId(capture),
        typeId: capture.typeId,
      }));
      const captureFields = captureFieldsForSite({
        liveSymbols: new Set(
          [...site.liveAfter].filter(
            (symbol) => !excludedSymbolsBySite.get(site.exprId)?.has(symbol),
          ),
        ),
        params,
        ordering,
        tempCaptures,
        symbolTypes,
        ctx,
      });
      const allCaptureFields = [
        ...captureFields,
        ...(extraCaptureFieldsBySite.get(site.exprId) ?? []),
      ];

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
                captureFields: allCaptureFields,
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
              captureFields: allCaptureFields,
            };

      siteCounter.current += 1;
      sites.push(lowered);
      sitesByExpr.set(site.exprId, lowered);
    });
  };

  ctx.module.hir.items.forEach((item) => {
    if (item.kind !== "function") return;
    const signature = ctx.program.functions.getSignature(
      ctx.moduleId,
      item.symbol,
    );
    const signatureType = signature
      ? ctx.program.types.getTypeDesc(signature.typeId)
      : undefined;
    const defaultParameters = item.parameters.flatMap((parameter, index) => {
      if (typeof parameter.defaultValue !== "number") return [];
      const typeId =
        signatureType?.kind === "function"
          ? signatureType.parameters[index]?.type
          : undefined;
      const temp =
        typeof typeId === "number"
          ? (() => {
              const tempId = allocateTempId({
                key: `defaultParam:${item.symbol}:${parameter.symbol}`,
                typeId,
              });
              const presenceTempId = allocateTempId({
                key: `defaultParamPresence:${item.symbol}:${parameter.symbol}`,
                typeId: ctx.program.primitives.i32,
              });
              const bindingKind = signature?.parameters[index]?.bindingKind;
              const value = {
                tempId,
                presenceTempId,
                typeId,
                storageRef:
                  getOptimizedParamAbiKind({
                    typeId,
                    bindingKind,
                    ctx,
                  }) !== "direct",
                bindingKind,
              };
              defaultParamTemps.set(parameter.symbol, value);
              return value;
            })()
          : undefined;
      return [{ parameter, exprId: parameter.defaultValue, temp }];
    });
    const effectInfo = effectsFacade(ctx).functionAbi(item.symbol);
    if (!effectInfo) return;
    if (!effectInfo.abiEffectful) return;

    const ordering = definitionOrderForFunction(item, ctx);
    const params = functionParamSymbols(item);
    const roots = [...defaultParameters.map(({ exprId }) => exprId), item.body];
    const symbolTypes = collectIdentifierSymbolTypes({
      exprIds: roots,
      ctx,
    });
    const bodyAnalysis = analyzeExpr({
      exprId: item.body,
      liveAfter: new Set(),
      ctx,
    });
    let live = bodyAnalysis.live;
    let analysisSites = [...bodyAnalysis.sites];
    const extraCaptureFieldsBySite = new Map<
      HirExprId,
      readonly ContinuationCaptureField[]
    >();
    const excludedSymbolsBySite = new Map<HirExprId, ReadonlySet<SymbolId>>();
    const excludedTempOwnersBySite = new Map<
      HirExprId,
      ReadonlySet<HirExprId>
    >();
    for (let index = defaultParameters.length - 1; index >= 0; index -= 1) {
      const current = defaultParameters[index]!;
      const defaultLiveAfter = new Set(live);
      defaultLiveAfter.delete(current.parameter.symbol);
      const defaultAnalysis = analyzeExpr({
        exprId: current.exprId,
        liveAfter: defaultLiveAfter,
        ctx,
      });
      const remainingRawParameters = defaultParameters
        .slice(index + 1)
        .flatMap(({ temp }) =>
          temp
            ? [
                {
                  sourceKind: "temp" as const,
                  tempId: temp.tempId,
                  typeId: temp.typeId,
                  storageRef: temp.storageRef,
                  bindingKind: temp.bindingKind,
                },
                {
                  sourceKind: "temp" as const,
                  tempId: temp.presenceTempId,
                  typeId: ctx.program.primitives.i32,
                },
              ]
            : [],
        );
      defaultAnalysis.sites.forEach((site) =>
        extraCaptureFieldsBySite.set(site.exprId, remainingRawParameters),
      );
      live = defaultAnalysis.live;
      analysisSites = [...defaultAnalysis.sites, ...analysisSites];
    }
    addGeneratedStateCaptures({
      rootExprId: item.body,
      analysisSites,
      extraCaptureFieldsBySite,
      excludedSymbolsBySite,
      excludedTempOwnersBySite,
    });
    const symbolId = ctx.program.symbols.idOf({
      moduleId: ctx.moduleId,
      symbol: item.symbol,
    });
    const fnName = sanitizeIdentifier(
      wasmSymbolName({ ctx, moduleId: ctx.moduleId, symbol: item.symbol }),
    );
    const contBaseName = `__cont_${sanitizeIdentifier(ctx.moduleLabel)}_${fnName}_${item.symbol}`;

    emitSitesFor({
      analysisSites,
      owner: { kind: "function", symbol: item.symbol },
      contBaseName,
      ordering,
      params,
      handlerAtSite: true,
      symbolTypes,
      extraCaptureFieldsBySite,
      excludedSymbolsBySite,
      excludedTempOwnersBySite,
    });
    if (
      typeof process !== "undefined" &&
      process.env.DEBUG_EFFECTS === "1" &&
      ctx.moduleId === "std::time" &&
      (ctx.program.symbols.getName(symbolId) ?? `${item.symbol}`) ===
        "run_timeout"
    ) {
      console.error(
        "[effects] run_timeout sites",
        analysisSites.map((site) => ({
          exprId: site.exprId,
          kind: site.kind,
          liveAfter: [...site.liveAfter],
          tempCaptures: site.tempCaptures,
        })),
      );
    }
  });

  ctx.module.hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "lambda") return;
    const lambdaAbi = effectsFacade(ctx).lambdaAbi(expr.id);
    if (!lambdaAbi?.shouldLower) return;

    const ordering = definitionOrderForLambda(expr, ctx);
    const params = lambdaParamSymbols(expr);
    const symbolTypes = collectIdentifierSymbolTypes({
      exprIds: [expr.body],
      ctx,
    });
    const fnName = `lambda_${expr.id}`;
    const contBaseName = `__cont_${sanitizeIdentifier(ctx.moduleLabel)}_${fnName}_${expr.id}`;
    const analysis = analyzeExpr({
      exprId: expr.body,
      liveAfter: new Set(),
      ctx,
    });
    const extraCaptureFieldsBySite = new Map<
      HirExprId,
      readonly ContinuationCaptureField[]
    >();
    const excludedSymbolsBySite = new Map<HirExprId, ReadonlySet<SymbolId>>();
    const excludedTempOwnersBySite = new Map<
      HirExprId,
      ReadonlySet<HirExprId>
    >();
    addGeneratedStateCaptures({
      rootExprId: expr.body,
      analysisSites: analysis.sites,
      extraCaptureFieldsBySite,
      excludedSymbolsBySite,
      excludedTempOwnersBySite,
    });

    emitSitesFor({
      analysisSites: analysis.sites,
      owner: { kind: "lambda", exprId: expr.id },
      contBaseName,
      ordering,
      params,
      handlerAtSite: true,
      symbolTypes,
      extraCaptureFieldsBySite,
      excludedSymbolsBySite,
      excludedTempOwnersBySite,
    });
  });

  ctx.module.hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "effect-handler") return;

    expr.handlers.forEach((clause, clauseIndex) => {
      const ordering = definitionOrderForHandlerClause({ clause, ctx });
      const params = handlerClauseParamSymbols(clause);
      const symbolTypes = collectIdentifierSymbolTypes({
        exprIds: [clause.body],
        ctx,
      });
      const skipCalleeSymbols = clause.parameters[0]
        ? new Set<SymbolId>([clause.parameters[0].symbol])
        : undefined;
      const analysis = analyzeExpr({
        exprId: clause.body,
        liveAfter: new Set(),
        ctx,
        skipCalleeSymbols,
      });
      const extraCaptureFieldsBySite = new Map<
        HirExprId,
        readonly ContinuationCaptureField[]
      >();
      const excludedSymbolsBySite = new Map<HirExprId, ReadonlySet<SymbolId>>();
      const excludedTempOwnersBySite = new Map<
        HirExprId,
        ReadonlySet<HirExprId>
      >();
      addGeneratedStateCaptures({
        rootExprId: clause.body,
        analysisSites: analysis.sites,
        extraCaptureFieldsBySite,
        excludedSymbolsBySite,
        excludedTempOwnersBySite,
      });
      const fnName = `handler_${expr.id}_${clauseIndex}`;
      const contBaseName = `__cont_${sanitizeIdentifier(ctx.moduleLabel)}_${fnName}`;

      emitSitesFor({
        analysisSites: analysis.sites,
        owner: { kind: "handler-clause", handlerExprId: expr.id, clauseIndex },
        contBaseName,
        ordering,
        params,
        handlerAtSite: true,
        symbolTypes,
        extraCaptureFieldsBySite,
        excludedSymbolsBySite,
        excludedTempOwnersBySite,
      });
    });
  });

  callArgTemps.forEach((value, key) => {
    const unique = new Map<
      number,
      { argIndex: number; tempId: number; typeId: TypeId }
    >();
    value.forEach((entry) => unique.set(entry.argIndex, entry));
    const sorted = [...unique.values()].sort((a, b) => a.argIndex - b.argIndex);
    callArgTemps.set(key, sorted);
  });

  return {
    sitesByExpr,
    sites,
    callArgTemps,
    tempTypeIds,
    defaultParamTemps,
    generatedStatesByStatement,
  };
};
