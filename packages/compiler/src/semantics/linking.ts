import { createTypeCheckBudgetState, createTypingState } from "./typing/context.js";
import type {
  CallArgumentPlanEntry,
  DependencySemantics,
  SymbolRefKey,
  TypingContext,
} from "./typing/types.js";
import {
  typeGenericFunctionBody,
  formatFunctionInstanceKey,
} from "./typing/expressions/call.js";
import { cloneNestedMap } from "./typing/call-resolution.js";
import { createImportMaps } from "./typing/import-maps.js";
import { createTypingContextFromTypingResult } from "./typing/context-from-typing-result.js";
import type { ModuleExportTable } from "./modules.js";
import type { SemanticsPipelineResult } from "./pipeline.js";
import type { MonomorphizedInstanceRequest } from "./codegen-view/index.js";
import { getSymbolTable } from "./_internal/symbol-table.js";
import type { HirExprId, SymbolId, TypeId } from "./ids.js";
import type { SymbolRef as ProgramSymbolRef } from "./program-symbol-arena.js";
import { createCanonicalSymbolRefResolver } from "./canonical-symbol-ref.js";
import type { SymbolRef as TypingSymbolRef } from "./typing/symbol-ref.js";
import {
  canonicalizeSymbolRef,
  parseSymbolRefKey,
} from "./typing/symbol-ref-utils.js";

export const monomorphizeProgram = ({
  modules,
  semantics,
}: {
  modules: readonly SemanticsPipelineResult[];
  semantics: Map<string, SemanticsPipelineResult>;
}): {
  instances: readonly MonomorphizedInstanceRequest[];
  moduleTyping: ReadonlyMap<
    string,
    {
      functionInstantiationInfo: ReadonlyMap<
        SymbolRefKey,
        ReadonlyMap<string, readonly TypeId[]>
      >;
      functionInstanceExprTypes: ReadonlyMap<
        string,
        ReadonlyMap<HirExprId, TypeId>
      >;
      functionInstanceValueTypes: ReadonlyMap<
        string,
        ReadonlyMap<SymbolId, TypeId>
      >;
      callTargets: ReadonlyMap<HirExprId, ReadonlyMap<string, TypingSymbolRef>>;
      callArgumentPlans: ReadonlyMap<
        HirExprId,
        ReadonlyMap<string, readonly CallArgumentPlanEntry[]>
      >;
      callTypeArguments: ReadonlyMap<HirExprId, ReadonlyMap<string, readonly TypeId[]>>;
      callInstanceKeys: ReadonlyMap<HirExprId, ReadonlyMap<string, string>>;
      callTraitDispatches: ReadonlySet<HirExprId>;
      valueTypes: ReadonlyMap<SymbolId, TypeId>;
    }
  >;
} => {
  modules.forEach((mod) => {
    mod.typing.functions.resetInstances();
  });

  const normalizeCallerInstanceKey = (key: string): string => {
    const lambdaIndex = key.indexOf("::lambda");
    return lambdaIndex >= 0 ? key.slice(0, lambdaIndex) : key;
  };

  const parseFunctionInstanceKey = (
    key: string
  ): { symbol: SymbolId; typeArgs: TypeId[] } | undefined => {
    const match = key.match(/^(\d+)<(.*)>$/);
    if (!match) return undefined;
    const symbol = Number(match[1]);
    if (!Number.isFinite(symbol)) return undefined;
    const argsSegment = match[2] ?? "";
    const typeArgs =
      argsSegment.length === 0
        ? []
        : argsSegment.split(",").map((value) => Number(value));
    if (typeArgs.some((arg) => !Number.isFinite(arg))) {
      return undefined;
    }
    return { symbol: symbol as SymbolId, typeArgs: typeArgs as TypeId[] };
  };

  const applyCallerInstanceSubstitution = ({
    callerCtx,
    callerInstanceKey,
    typeArgs,
  }: {
    callerCtx: TypingContext;
    callerInstanceKey: string;
    typeArgs: readonly TypeId[];
  }): readonly TypeId[] => {
    const parsed = parseFunctionInstanceKey(normalizeCallerInstanceKey(callerInstanceKey));
    if (!parsed) {
      return typeArgs;
    }
    const signature = callerCtx.functions.getSignature(parsed.symbol);
    const typeParams = signature?.typeParams ?? [];
    if (!signature || typeParams.length === 0) {
      return typeArgs;
    }
    if (typeParams.length !== parsed.typeArgs.length) {
      return typeArgs;
    }
    const substitution = new Map(
      typeParams.map(
        (param, index) => [param.typeParam, parsed.typeArgs[index]!] as const
      )
    );
    return typeArgs.map((typeArg) => callerCtx.arena.substitute(typeArg, substitution));
  };

  const stableModules = [...modules].sort((a, b) =>
    a.moduleId.localeCompare(b.moduleId, undefined, { numeric: true })
  );

  const importTargetsByModule = new Map<string, Map<SymbolId, ProgramSymbolRef>>();
  stableModules.forEach((mod) => {
    const byLocal = new Map<SymbolId, ProgramSymbolRef>();
    mod.binding.imports.forEach((imp) => {
      if (!imp.target) return;
      byLocal.set(imp.local, { moduleId: imp.target.moduleId, symbol: imp.target.symbol });
    });
    importTargetsByModule.set(mod.moduleId, byLocal);
  });

  const resolveImportTarget = (ref: ProgramSymbolRef): ProgramSymbolRef | undefined =>
    importTargetsByModule.get(ref.moduleId)?.get(ref.symbol);

  const canonicalSymbolRef = createCanonicalSymbolRefResolver({ resolveImportTarget });

  const { moduleExports, dependencies } = buildDependencyIndex(semantics);
  const typingContexts = new Map<string, TypingContext>();
  const typingContextFor = createTypingContextFactory({
    semantics,
    moduleExports,
    dependencies,
    typingContexts,
  });

  const touchedModules = new Set<string>();

  const requestedInstances: MonomorphizedInstanceRequest[] = [];

  const seenRequestKeys = new Set<string>();
  const moduleQueue: string[] = [];
  const queuedModules = new Set<string>();
  const enqueueModule = (moduleId: string): void => {
    if (queuedModules.has(moduleId)) {
      return;
    }
    queuedModules.add(moduleId);
    moduleQueue.push(moduleId);
  };
  modules.forEach((mod) => enqueueModule(mod.moduleId));

  const requestInstantiation = ({
    callerModuleId,
    calleeRef,
    typeArgs,
  }: {
    callerModuleId: string;
    calleeRef: TypingSymbolRef;
    typeArgs: readonly TypeId[];
  }): void => {
    if (calleeRef.moduleId === callerModuleId) {
      return;
    }
    const canonicalCallee = canonicalSymbolRef(calleeRef);
    const callee = semantics.get(canonicalCallee.moduleId);
    const calleeCtx = callee ? typingContextFor(canonicalCallee.moduleId) : undefined;
    if (!callee || !calleeCtx) {
      return;
    }
    const calleeSignature = callee.typing.functions.getSignature(canonicalCallee.symbol);
    const typeParams = calleeSignature?.typeParams ?? [];
    if (!calleeSignature || typeParams.length === 0) {
      return;
    }
    if (typeArgs.length !== typeParams.length) {
      return;
    }
    const requestKey = `${canonicalCallee.moduleId}::${canonicalCallee.symbol}<${typeArgs.join(",")}>`;
    if (seenRequestKeys.has(requestKey)) {
      return;
    }
    seenRequestKeys.add(requestKey);
    requestedInstances.push({
      callee: canonicalCallee,
      typeArgs: [...typeArgs],
    });
    const substitution = new Map(
      typeParams.map((param, index) => [param.typeParam, typeArgs[index]!] as const)
    );
    typeGenericFunctionBody({
      symbol: canonicalCallee.symbol,
      signature: calleeSignature,
      substitution,
      ctx: calleeCtx,
      state: createTypingState("relaxed"),
    });
    touchedModules.add(canonicalCallee.moduleId);
    enqueueModule(canonicalCallee.moduleId);
  };

  const processModuleQueue = (): void => {
    while (moduleQueue.length > 0) {
      const callerModuleId = moduleQueue.shift();
      if (!callerModuleId) {
        continue;
      }
      queuedModules.delete(callerModuleId);
      const callerCtx = typingContextFor(callerModuleId);
      if (!callerCtx) {
        continue;
      }

      const callTargets = callerCtx.callResolution.targets;
      const callTypeArguments = callerCtx.callResolution.typeArguments;
      callTargets.forEach((targets, callId) => {
        targets.forEach((targetRef, callerInstanceKey) => {
          const rawTypeArgs = callTypeArguments.get(callId)?.get(callerInstanceKey);
          if (!rawTypeArgs || rawTypeArgs.length === 0) {
            return;
          }
          const typeArgs = applyCallerInstanceSubstitution({
            callerCtx,
            callerInstanceKey,
            typeArgs: rawTypeArgs,
          });
          requestInstantiation({ callerModuleId, calleeRef: targetRef, typeArgs });
        });
      });

      const instantiationSources: Array<
        ReadonlyMap<SymbolRefKey, ReadonlyMap<string, readonly TypeId[]>>
      > = [callerCtx.functions.snapshotInstantiationInfo()];
      const priorInstantiationInfo =
        semantics.get(callerModuleId)?.typing.functionInstantiationInfo;
      if (priorInstantiationInfo) {
        instantiationSources.push(priorInstantiationInfo);
      }

      instantiationSources.forEach((instantiationInfo) => {
        const sortedRefKeys = Array.from(instantiationInfo.keys()).sort((a, b) =>
          a.localeCompare(b, undefined, { numeric: true })
        );
        sortedRefKeys.forEach((refKey) => {
          const instantiations = instantiationInfo.get(refKey);
          if (!instantiations) {
            return;
          }
          const parsed = parseSymbolRefKey(refKey);
          if (!parsed || parsed.moduleId === callerModuleId) {
            return;
          }
          const sortedInstantiations = Array.from(instantiations.entries()).sort(([a], [b]) =>
            a.localeCompare(b, undefined, { numeric: true })
          );
          sortedInstantiations.forEach(([, typeArgs]) => {
            requestInstantiation({ callerModuleId, calleeRef: parsed, typeArgs });
          });
        });
      });
    }
  };

  processModuleQueue();

  requestedInstances.forEach((request) => {
    const calleeRef = request.callee;
    const callee = semantics.get(calleeRef.moduleId);
    const calleeCtx = callee ? typingContextFor(calleeRef.moduleId) : undefined;
    if (!callee || !calleeCtx) {
      return;
    }
    const calleeSignature = callee.typing.functions.getSignature(calleeRef.symbol);
    const typeParams = calleeSignature?.typeParams ?? [];
    if (!calleeSignature || typeParams.length === 0) {
      return;
    }
    if (request.typeArgs.length !== typeParams.length) {
      return;
    }
    const instanceKey = formatFunctionInstanceKey(calleeRef.symbol, request.typeArgs);
    if (!calleeCtx.functions.getInstanceExprTypes(instanceKey)) {
      const substitution = new Map(
        typeParams.map(
          (param, index) => [param.typeParam, request.typeArgs[index]!] as const
        )
      );
      typeGenericFunctionBody({
        symbol: calleeRef.symbol,
        signature: calleeSignature,
        substitution,
        ctx: calleeCtx,
        state: createTypingState("relaxed"),
      });
    }
    touchedModules.add(calleeRef.moduleId);
    enqueueModule(calleeRef.moduleId);
  });

  processModuleQueue();

  const instanceRequests = new Map<string, MonomorphizedInstanceRequest>();
  requestedInstances.forEach((info) => {
    const key = `${info.callee.moduleId}::${info.callee.symbol}<${info.typeArgs.join(",")}>`;
    if (!instanceRequests.has(key)) {
      instanceRequests.set(key, info);
    }
  });

  const instances = Array.from(instanceRequests.values()).sort((a, b) => {
    const calleeOrder = a.callee.moduleId.localeCompare(b.callee.moduleId, undefined, {
      numeric: true,
    });
    if (calleeOrder !== 0) {
      return calleeOrder;
    }
    if (a.callee.symbol !== b.callee.symbol) {
      return a.callee.symbol - b.callee.symbol;
    }
    return a.typeArgs.join(",").localeCompare(b.typeArgs.join(","), undefined, {
      numeric: true,
    });
  });

  const moduleTyping = new Map<
    string,
    {
      functionInstantiationInfo: ReadonlyMap<
        SymbolRefKey,
        ReadonlyMap<string, readonly TypeId[]>
      >;
      functionInstanceExprTypes: ReadonlyMap<
        string,
        ReadonlyMap<HirExprId, TypeId>
      >;
      functionInstanceValueTypes: ReadonlyMap<
        string,
        ReadonlyMap<SymbolId, TypeId>
      >;
      callTargets: ReadonlyMap<HirExprId, ReadonlyMap<string, TypingSymbolRef>>;
      callArgumentPlans: ReadonlyMap<
        HirExprId,
        ReadonlyMap<string, readonly CallArgumentPlanEntry[]>
      >;
      callTypeArguments: ReadonlyMap<HirExprId, ReadonlyMap<string, readonly TypeId[]>>;
      callInstanceKeys: ReadonlyMap<HirExprId, ReadonlyMap<string, string>>;
      callTraitDispatches: ReadonlySet<HirExprId>;
      valueTypes: ReadonlyMap<SymbolId, TypeId>;
    }
  >();

  touchedModules.forEach((moduleId) => {
    const ctx = typingContexts.get(moduleId);
    if (!ctx) return;
    moduleTyping.set(moduleId, {
      functionInstantiationInfo: ctx.functions.snapshotInstantiationInfo(),
      functionInstanceExprTypes: ctx.functions.snapshotInstanceExprTypes(),
      functionInstanceValueTypes: ctx.functions.snapshotInstanceValueTypes(),
      callTargets: cloneNestedMap(ctx.callResolution.targets),
      callArgumentPlans: cloneNestedMap(ctx.callResolution.argumentPlans),
      callTypeArguments: cloneNestedMap(ctx.callResolution.typeArguments),
      callInstanceKeys: cloneNestedMap(ctx.callResolution.instanceKeys),
      callTraitDispatches: new Set(ctx.callResolution.traitDispatches),
      valueTypes: new Map(ctx.valueTypes),
    });
  });

  return { instances, moduleTyping };
};

const buildDependencyIndex = (
  semantics: Map<string, SemanticsPipelineResult>
): {
  moduleExports: Map<string, ModuleExportTable>;
  dependencies: Map<string, DependencySemantics>;
} => {
  const moduleExports = new Map<string, ModuleExportTable>();
  const dependencies = new Map<string, DependencySemantics>();

  semantics.forEach((entry, id) => {
    moduleExports.set(id, entry.exports);
    dependencies.set(id, {
      moduleId: entry.moduleId,
      packageId: entry.binding.packageId,
      symbolTable: getSymbolTable(entry),
      hir: entry.hir,
      typing: entry.typing,
      decls: entry.binding.decls,
      overloads: collectOverloadOptions(
        entry.binding.overloads,
        entry.binding.importedOverloadOptions
      ),
      exports: entry.exports,
    });
  });

  return { moduleExports, dependencies };
};

const createTypingContextFactory = ({
  semantics,
  moduleExports,
  dependencies,
  typingContexts,
}: {
  semantics: Map<string, SemanticsPipelineResult>;
  moduleExports: Map<string, ModuleExportTable>;
  dependencies: Map<string, DependencySemantics>;
  typingContexts: Map<string, TypingContext>;
}): ((moduleId: string) => TypingContext | undefined) => {
  const typingContextFor = (moduleId: string): TypingContext | undefined => {
    const cached = typingContexts.get(moduleId);
    if (cached) {
      return cached;
    }

    const entry = semantics.get(moduleId);
    if (!entry) {
      return undefined;
    }

    const entrySymbolTable = getSymbolTable(entry);
    const resolveImportTarget = (
      ref: TypingSymbolRef,
    ): TypingSymbolRef | undefined => {
      const symbolTable = ref.moduleId === moduleId
        ? entrySymbolTable
        : dependencies.get(ref.moduleId)?.symbolTable;
      if (!symbolTable) {
        return undefined;
      }
      try {
        const metadata = (symbolTable.getSymbol(ref.symbol).metadata ?? {}) as
          | {
              import?: {
                moduleId?: unknown;
                symbol?: unknown;
              };
            }
          | undefined;
        if (
          typeof metadata?.import?.moduleId === "string" &&
          typeof metadata.import.symbol === "number"
        ) {
          return {
            moduleId: metadata.import.moduleId,
            symbol: metadata.import.symbol,
          };
        }
      } catch {
        return undefined;
      }
      return undefined;
    };

    const { importsByLocal, importAliasesByModule } = createImportMaps(
      entry.binding.imports,
      {
        canonicalizeTarget: (target) =>
          canonicalizeSymbolRef({
            ref: target,
            resolveImportTarget,
          }),
      },
    );

    const ctx = createTypingContextFromTypingResult({
      symbolTable: entrySymbolTable,
      hir: entry.hir,
      overloads: collectOverloadOptions(
        entry.binding.overloads,
        entry.binding.importedOverloadOptions,
      ),
      typeCheckBudget: createTypeCheckBudgetState(),
      decls: entry.binding.decls,
      moduleId: entry.moduleId,
      packageId: entry.binding.packageId,
      moduleExports,
      dependencies,
      importsByLocal,
      importAliasesByModule,
      typing: entry.typing,
    });

    typingContexts.set(moduleId, ctx);
    return ctx;
  };

  return typingContextFor;
};

const collectOverloadOptions = (
  overloads: ReadonlyMap<number, { functions: readonly { symbol: number }[] }>,
  imported?: ReadonlyMap<number, readonly number[]>
): Map<number, readonly number[]> => {
  const entries = new Map<number, readonly number[]>(
    Array.from(overloads.entries()).map(([id, set]) => [
      id,
      set.functions.map((fn) => fn.symbol),
    ])
  );
  if (imported) {
    imported.forEach((symbols, id) => {
      entries.set(id, symbols);
    });
  }
  return entries;
};
