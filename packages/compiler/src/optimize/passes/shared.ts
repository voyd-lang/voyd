import type {
  HirExpression,
  HirFunction,
  HirModuleLet,
} from "../../semantics/hir/index.js";
import { walkExpression } from "../../semantics/hir/index.js";
import type {
  ModuleCodegenView,
  ProgramCodegenView,
} from "../../semantics/codegen-view/index.js";
import { getSymbolTable } from "../../semantics/_internal/symbol-table.js";
import type {
  HirExprId,
  ProgramFunctionId,
  ProgramFunctionInstanceId,
  ProgramSymbolId,
  SymbolId,
  TypeId,
} from "../../semantics/ids.js";
import type { OptimizedCallInfo, ReadonlyOptimizedModuleView } from "../ir.js";
import { type ProgramOptimizationIR } from "../ir.js";

export const exactNominalForType = ({
  typeId,
  program,
}: {
  typeId: TypeId | undefined;
  program: ProgramCodegenView;
}): TypeId | undefined => {
  if (typeof typeId !== "number") {
    return undefined;
  }
  const desc = program.types.getTypeDesc(typeId);
  if (desc.kind === "nominal-object" || desc.kind === "value-object") {
    return typeId;
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    return desc.nominal;
  }
  return undefined;
};

export const exprTypeFor = ({
  moduleView,
  exprId,
}: {
  moduleView: ModuleCodegenView;
  exprId: HirExprId;
}): TypeId | undefined =>
  moduleView.types.getResolvedExprType(exprId) ??
  moduleView.types.getExprType(exprId);

export const resolveCallTypeArgs = ({
  callInfo,
  callerInstanceId,
}: {
  callInfo: OptimizedCallInfo;
  callerInstanceId?: ProgramFunctionInstanceId;
}): readonly TypeId[] => {
  if (
    typeof callerInstanceId === "number" &&
    callInfo.typeArgs?.has(callerInstanceId)
  ) {
    return callInfo.typeArgs.get(callerInstanceId) ?? [];
  }
  return callInfo.typeArgs?.size === 1
    ? (callInfo.typeArgs.values().next().value ?? [])
    : [];
};

export const resolveCallArgPlan = ({
  callInfo,
  callerInstanceId,
}: {
  callInfo: OptimizedCallInfo;
  callerInstanceId?: ProgramFunctionInstanceId;
}) => {
  if (
    typeof callerInstanceId === "number" &&
    callInfo.argPlans?.has(callerInstanceId)
  ) {
    return callInfo.argPlans.get(callerInstanceId);
  }
  return callInfo.argPlans?.size === 1
    ? callInfo.argPlans.values().next().value
    : undefined;
};

export const callArgumentExprIdForParameter = ({
  argExprIds,
  callInfo,
  callerInstanceId,
  parameterIndex,
}: {
  argExprIds: readonly HirExprId[];
  callInfo: OptimizedCallInfo | undefined;
  callerInstanceId: ProgramFunctionInstanceId;
  parameterIndex: number;
}): HirExprId | undefined => {
  const argPlan = callInfo
    ? resolveCallArgPlan({ callInfo, callerInstanceId })
    : undefined;
  if (!argPlan) {
    return argExprIds[parameterIndex];
  }
  const entry = argPlan[parameterIndex];
  return entry?.kind === "direct" ? argExprIds[entry.argIndex] : undefined;
};

export const exactNominalForExpr = ({
  moduleView,
  exprId,
  callerInstanceId,
  program,
  exactParameterTypes,
}: {
  moduleView: ModuleCodegenView;
  exprId: HirExprId;
  callerInstanceId?: ProgramFunctionInstanceId;
  program: ProgramCodegenView;
  exactParameterTypes?: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, TypeId>
  >;
}): TypeId | undefined => {
  const typeId =
    typeof callerInstanceId === "number"
      ? (program.functions.getInstanceExprType(callerInstanceId, exprId) ??
        exprTypeFor({ moduleView, exprId }))
      : exprTypeFor({ moduleView, exprId });
  const exactStaticType = exactNominalForType({ typeId, program });
  if (typeof exactStaticType === "number") {
    return exactStaticType;
  }

  const expr = moduleView.hir.expressions.get(exprId);
  if (
    expr?.exprKind === "object-literal" &&
    expr.literalKind === "nominal" &&
    typeof expr.targetSymbol === "number"
  ) {
    const template = program.objects.getTemplate(
      program.symbols.idOf({
        moduleId: moduleView.moduleId,
        symbol: expr.targetSymbol,
      }),
    );
    if (typeof template?.nominal === "number") {
      return template.nominal;
    }
  }

  if (expr?.exprKind === "identifier" && typeof callerInstanceId === "number") {
    const exactParam = exactParameterTypes
      ?.get(callerInstanceId)
      ?.get(expr.symbol);
    if (typeof exactParam === "number") {
      return exactParam;
    }
  }

  return undefined;
};

export const functionTypeSubstitution = ({
  signature,
  typeArgs,
  program,
}: {
  signature: NonNullable<
    ReturnType<ProgramCodegenView["functions"]["getSignature"]>
  >;
  typeArgs: readonly TypeId[];
  program: ProgramCodegenView;
}) => {
  if (typeArgs.length === 0) {
    return undefined;
  }
  const paramIds =
    signature.typeParams.length > 0
      ? signature.typeParams.map((param) => param.typeParam)
      : program.types.getScheme(signature.scheme).params;
  return paramIds.length === typeArgs.length
    ? new Map(
        paramIds.map((param, index) => [param, typeArgs[index]!] as const),
      )
    : undefined;
};

export const collectHandlerCaptures = ({
  moduleView,
}: {
  moduleView: ReadonlyOptimizedModuleView;
}): Map<HirExprId, Map<number, readonly SymbolId[]>> => {
  const handlerCaptures = new Map<
    HirExprId,
    Map<number, readonly SymbolId[]>
  >();
  const symbolTable = getSymbolTable(moduleView.semantics);

  moduleView.hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "effect-handler") {
      return;
    }
    const clauseCaptures = new Map<number, readonly SymbolId[]>();
    expr.handlers.forEach((clause, clauseIndex) => {
      const clauseParams = new Set(
        clause.parameters.map((parameter) => parameter.symbol),
      );
      const captures = new Set<SymbolId>();
      walkExpression({
        exprId: clause.body,
        hir: moduleView.hir,
        onEnterExpression: (_exprId, nestedExpr) => {
          if (nestedExpr.exprKind !== "identifier") {
            return;
          }
          if (clauseParams.has(nestedExpr.symbol)) {
            return;
          }
          const symbolRecord = symbolTable.getSymbol(nestedExpr.symbol);
          const metadata = (symbolRecord.metadata ?? {}) as {
            import?: unknown;
          };
          if (metadata.import) {
            return;
          }
          if (symbolRecord.scope === symbolTable.rootScope) {
            return;
          }
          captures.add(nestedExpr.symbol);
        },
      });
      clauseCaptures.set(
        clauseIndex,
        [...captures].sort((a, b) => a - b),
      );
    });
    handlerCaptures.set(expr.id, clauseCaptures);
  });

  return handlerCaptures;
};

export const functionItemBySymbol = ({
  ir,
  moduleView,
  symbol,
}: {
  ir: ProgramOptimizationIR;
  moduleView: ModuleCodegenView;
  symbol: SymbolId;
}): HirFunction | undefined =>
  ir.index.getFunction(moduleView.moduleId, symbol)?.item;

export type IndexedInstanceCallSite = {
  moduleView: ReadonlyOptimizedModuleView;
  exprId: HirExprId;
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
};

export type InstanceCallSiteIndex = ReadonlyMap<
  ProgramFunctionInstanceId,
  readonly IndexedInstanceCallSite[]
>;

export const buildInstanceCallSiteIndex = ({
  ir,
}: {
  ir: ProgramOptimizationIR;
}): Map<ProgramFunctionInstanceId, IndexedInstanceCallSite[]> => {
  const callSites = new Map<
    ProgramFunctionInstanceId,
    IndexedInstanceCallSite[]
  >();
  ir.facts.reachableFunctionInstances.forEach((instanceId) => {
    const instance = ir.baseProgram.functions.getInstance(instanceId);
    const moduleView = ir.modules.get(instance.symbolRef.moduleId);
    const item = ir.index.getFunction(
      instance.symbolRef.moduleId,
      instance.symbolRef.symbol,
    )?.item;
    if (!moduleView || !item) {
      return;
    }
    const seenExprIds = new Set<HirExprId>();
    const indexed: IndexedInstanceCallSite[] = [];
    const roots = ir.index.getFunctionRootExprIds(
      moduleView.moduleId,
      item.symbol,
    );
    roots.forEach((rootExprId) => {
      ir.index
        .getBodyTopology({ moduleId: moduleView.moduleId, rootExprId })
        .callSiteExprIds.forEach((exprId) => {
          if (seenExprIds.has(exprId)) {
            return;
          }
          seenExprIds.add(exprId);
          const expr = moduleView.hir.expressions.get(exprId);
          if (
            !expr ||
            (expr.exprKind !== "call" && expr.exprKind !== "method-call")
          ) {
            return;
          }
          indexed.push({ moduleView, exprId, expr });
        });
    });
    callSites.set(instanceId, indexed);
  });
  return callSites;
};

export const callArgumentExprIds = (
  expr: HirExpression,
): readonly HirExprId[] =>
  expr.exprKind === "call"
    ? expr.args.map((arg) => arg.expr)
    : expr.exprKind === "method-call"
      ? [expr.target, ...expr.args.map((arg) => arg.expr)]
      : [];

export const resolveDirectIdentifierCallTarget = ({
  moduleView,
  expr,
  typeArgs,
  ir,
}: {
  moduleView: ReadonlyOptimizedModuleView;
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  typeArgs: readonly TypeId[];
  ir: ProgramOptimizationIR;
}): readonly {
  functionId: ProgramFunctionId;
  instanceId?: ProgramFunctionInstanceId;
}[] => {
  if (expr.exprKind !== "call") {
    return [];
  }
  const callee = moduleView.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return [];
  }
  const resolved = resolveImportedSymbol({
    moduleId: moduleView.moduleId,
    symbol: callee.symbol,
    ir,
  });
  const module = ir.modules.get(resolved.moduleId);
  if (
    !module ||
    !functionItemBySymbol({ ir, moduleView: module, symbol: resolved.symbol })
  ) {
    return [];
  }
  const functionId = canonicalProgramSymbolIdOf({
    moduleId: resolved.moduleId,
    symbol: resolved.symbol,
    ir,
  });
  return [
    {
      functionId,
      instanceId: ir.baseProgram.functions.getInstanceId(
        resolved.moduleId,
        resolved.symbol,
        typeArgs,
      ),
    },
  ];
};

export const resolveTargetsForExactPropagation = ({
  moduleView,
  exprId,
  expr,
  callerInstanceId,
  ir,
}: {
  moduleView: ReadonlyOptimizedModuleView;
  exprId: HirExprId;
  expr: Extract<HirExpression, { exprKind: "call" | "method-call" }>;
  callerInstanceId: ProgramFunctionInstanceId;
  ir: ProgramOptimizationIR;
}): readonly {
  functionId: ProgramFunctionId;
  instanceId?: ProgramFunctionInstanceId;
}[] => {
  const resolvedTargets = resolveTargetsForCaller({
    moduleId: moduleView.moduleId,
    exprId,
    callerInstanceId,
    ir,
  });
  if (resolvedTargets.length > 0 || expr.exprKind !== "call") {
    return resolvedTargets;
  }
  const callInfo = ir.calls.get(moduleView.moduleId)?.get(exprId);
  const typeArgs = callInfo
    ? resolveCallTypeArgs({ callInfo, callerInstanceId })
    : [];
  return resolveDirectIdentifierCallTarget({ moduleView, expr, typeArgs, ir });
};

export const externallyCallableFunctionInstances = (
  ir: ProgramOptimizationIR,
): Set<ProgramFunctionInstanceId> => {
  const external = new Set<ProgramFunctionInstanceId>();
  const addFunctionSymbolInstances = ({
    moduleId,
    symbol,
  }: {
    moduleId: string;
    symbol: SymbolId;
  }): void => {
    const instantiations = ir.functionInstantiations.get(moduleId)?.get(symbol);
    if (instantiations) {
      instantiations.forEach((_typeArgs, instanceId) => {
        external.add(instanceId);
      });
      return;
    }
    const instanceId = ir.baseProgram.functions.getInstanceId(
      moduleId,
      symbol,
      [],
    );
    if (typeof instanceId === "number") {
      external.add(instanceId);
    }
  };

  const externalModuleIds =
    ir.options.testMode && ir.options.testScope === "all"
      ? new Set(ir.modules.keys())
      : new Set([ir.entryModuleId]);
  externalModuleIds.forEach((moduleId) => {
    const moduleView = ir.modules.get(moduleId);
    if (!moduleView) {
      return;
    }
    moduleView.hir.module.exports.forEach((entry) => {
      const resolved = resolveImportedSymbol({
        moduleId,
        symbol: entry.symbol,
        ir,
      });
      const resolvedModule = ir.modules.get(resolved.moduleId);
      if (
        !resolvedModule ||
        !functionItemBySymbol({
          ir,
          moduleView: resolvedModule,
          symbol: resolved.symbol,
        })
      ) {
        return;
      }
      addFunctionSymbolInstances(resolved);
    });
  });

  const markEscapedFunctionValues = ({
    moduleView,
    rootExprId,
  }: {
    moduleView: ReadonlyOptimizedModuleView;
    rootExprId: HirExprId;
  }): void => {
    const directCallCallees = new Set<HirExprId>();
    const exprIds = ir.index.getBodyTopology({
      moduleId: moduleView.moduleId,
      rootExprId,
    }).postOrderExprIds;
    exprIds.forEach((exprId) => {
      const expr = moduleView.hir.expressions.get(exprId);
      if (expr?.exprKind === "call") {
        directCallCallees.add(expr.callee);
      }
    });

    exprIds.forEach((exprId) => {
      if (directCallCallees.has(exprId)) {
        return;
      }
      const expr = moduleView.hir.expressions.get(exprId);
      if (expr?.exprKind !== "identifier") {
        return;
      }
      const resolved = resolveImportedSymbol({
        moduleId: moduleView.moduleId,
        symbol: expr.symbol,
        ir,
      });
      const resolvedModule = ir.modules.get(resolved.moduleId);
      if (
        !resolvedModule ||
        !functionItemBySymbol({
          ir,
          moduleView: resolvedModule,
          symbol: resolved.symbol,
        })
      ) {
        return;
      }
      addFunctionSymbolInstances(resolved);
    });
  };

  ir.facts.reachableFunctionInstances.forEach((instanceId) => {
    const instance = ir.baseProgram.functions.getInstance(instanceId);
    const moduleView = ir.modules.get(instance.symbolRef.moduleId);
    const item = moduleView
      ? functionItemBySymbol({
          ir,
          moduleView,
          symbol: instance.symbolRef.symbol,
        })
      : undefined;
    if (!moduleView || !item) {
      return;
    }
    [
      item.body,
      ...item.parameters.flatMap((parameter) =>
        typeof parameter.defaultValue === "number"
          ? [parameter.defaultValue]
          : [],
      ),
    ].forEach((rootExprId) => {
      markEscapedFunctionValues({ moduleView, rootExprId });
    });
  });

  ir.facts.reachableModuleLets.forEach((symbols, moduleId) => {
    const moduleView = ir.modules.get(moduleId);
    if (!moduleView) {
      return;
    }
    symbols.forEach((symbol) => {
      const moduleLet = moduleLetBySymbol({ ir, moduleView, symbol });
      if (!moduleLet) {
        return;
      }
      markEscapedFunctionValues({
        moduleView,
        rootExprId: moduleLet.initializer,
      });
    });
  });
  return external;
};

export const receiverSpecializationCallSiteKey = ({
  moduleId,
  exprId,
}: {
  moduleId: string;
  exprId: HirExprId;
}): string => `${moduleId}:${exprId}`;

export const knownNominalsForExpr = ({
  moduleView,
  exprId,
  callerInstanceId,
  program,
  exactParameterTypes,
  knownParameterTypes,
}: {
  moduleView: ModuleCodegenView;
  exprId: HirExprId;
  callerInstanceId?: ProgramFunctionInstanceId;
  program: ProgramCodegenView;
  exactParameterTypes: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, TypeId>
  >;
  knownParameterTypes: ReadonlyMap<
    ProgramFunctionInstanceId,
    ReadonlyMap<SymbolId, ReadonlySet<TypeId>>
  >;
}): ReadonlySet<TypeId> | undefined => {
  const exact = exactNominalForExpr({
    moduleView,
    exprId,
    callerInstanceId,
    program,
    exactParameterTypes,
  });
  if (typeof exact === "number") {
    return new Set([exact]);
  }
  if (typeof callerInstanceId !== "number") {
    return undefined;
  }
  const expr = moduleView.hir.expressions.get(exprId);
  if (expr?.exprKind !== "identifier") {
    return undefined;
  }
  return knownParameterTypes.get(callerInstanceId)?.get(expr.symbol);
};

export const resolveImportedSymbol = ({
  moduleId,
  symbol,
  ir,
}: {
  moduleId: string;
  symbol: SymbolId;
  ir: ProgramOptimizationIR;
}): { moduleId: string; symbol: SymbolId } => {
  return ir.index.resolveImportedSymbol(moduleId, symbol);
};

export const moduleLetBySymbol = ({
  ir,
  moduleView,
  symbol,
}: {
  ir: ProgramOptimizationIR;
  moduleView: ReadonlyOptimizedModuleView;
  symbol: SymbolId;
}): HirModuleLet | undefined =>
  ir.index.getModuleLet(moduleView.moduleId, symbol)?.item;

export const canonicalProgramSymbolIdOf = ({
  moduleId,
  symbol,
  ir,
}: {
  moduleId: string;
  symbol: SymbolId;
  ir: ProgramOptimizationIR;
}): ProgramSymbolId =>
  ir.baseProgram.symbols.canonicalIdOf(moduleId, symbol) as ProgramSymbolId;

export const resolveTargetsForCaller = ({
  moduleId,
  exprId,
  callerInstanceId,
  ir,
}: {
  moduleId: string;
  exprId: HirExprId;
  callerInstanceId?: ProgramFunctionInstanceId;
  ir: ProgramOptimizationIR;
}): readonly {
  functionId: ProgramFunctionId;
  instanceId?: ProgramFunctionInstanceId;
}[] => {
  const callInfo = ir.calls.get(moduleId)?.get(exprId);
  if (!callInfo) {
    return [];
  }
  const resolveTypeArgsForCaller = (
    typeArgs: readonly TypeId[],
  ): readonly TypeId[] => {
    if (typeof callerInstanceId !== "number" || typeArgs.length === 0) {
      return typeArgs;
    }
    const caller = ir.baseProgram.functions.getInstance(callerInstanceId);
    const signature = ir.baseProgram.functions.getSignature(
      caller.symbolRef.moduleId,
      caller.symbolRef.symbol,
    );
    if (!signature) {
      return typeArgs;
    }
    const substitution = functionTypeSubstitution({
      signature,
      typeArgs: caller.typeArgs,
      program: ir.baseProgram,
    });
    return substitution
      ? typeArgs.map((typeArg) =>
          ir.baseProgram.types.substitute(typeArg, substitution),
        )
      : typeArgs;
  };
  const exactTarget =
    typeof callerInstanceId === "number"
      ? callInfo.targets?.get(callerInstanceId)
      : undefined;
  const exactTypeArgs =
    typeof callerInstanceId === "number"
      ? callInfo.typeArgs?.get(callerInstanceId)
      : undefined;
  const candidateEntries =
    typeof exactTarget === "number"
      ? [
          {
            functionId: exactTarget,
            typeArgs: resolveTypeArgsForCaller(exactTypeArgs ?? []),
          },
        ]
      : callInfo.targets
        ? Array.from(callInfo.targets.entries()).map(
            ([targetCallerInstanceId, functionId]) => ({
              functionId,
              typeArgs: resolveTypeArgsForCaller(
                callInfo.typeArgs?.get(targetCallerInstanceId) ?? [],
              ),
            }),
          )
        : [];

  return Array.from(
    new Map(
      candidateEntries.map((entry) => {
        const ref = ir.baseProgram.symbols.refOf(
          entry.functionId as ProgramSymbolId,
        );
        const instanceId = ir.baseProgram.functions.getInstanceId(
          ref.moduleId,
          ref.symbol,
          entry.typeArgs,
        );
        return [
          `${entry.functionId}:${entry.typeArgs.join(",")}`,
          {
            functionId: entry.functionId,
            instanceId,
          },
        ] as const;
      }),
    ).values(),
  );
};
