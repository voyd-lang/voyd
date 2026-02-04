import { DiagnosticEmitter } from "../diagnostics/index.js";
import { createTypingState } from "./typing/context.js";
import type { DependencySemantics, SymbolRefKey, TypingContext } from "./typing/types.js";
import {
  typeGenericFunctionBody,
} from "./typing/expressions/call.js";
import { cloneNestedMap } from "./typing/call-resolution.js";
import type { ModuleExportTable } from "./modules.js";
import type { SemanticsPipelineResult } from "./pipeline.js";
import type { MonomorphizedInstanceRequest } from "./codegen-view/index.js";
import { getSymbolTable } from "./_internal/symbol-table.js";
import type { HirExprId, SymbolId, TypeId } from "./ids.js";
import { buildProgramSymbolArena, type SymbolRef as ProgramSymbolRef } from "./program-symbol-arena.js";
import { createCanonicalSymbolRefResolver } from "./canonical-symbol-ref.js";
import type { SymbolRef as TypingSymbolRef } from "./typing/symbol-ref.js";
import { parseSymbolRefKey } from "./typing/symbol-ref-utils.js";

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
  const programSymbols = buildProgramSymbolArena(stableModules);

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
      callee: programSymbols.idOf(canonicalCallee),
      typeArgs,
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

	    const instantiationSources = [
	      callerCtx.functions.snapshotInstantiationInfo(),
	      semantics.get(callerModuleId)?.typing.functionInstantiationInfo,
	    ].filter(Boolean);

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

  const getOrCreateMap = <K, V>(map: Map<K, V>, key: K, create: () => V): V => {
    const existing = map.get(key);
    if (existing) {
      return existing;
    }
    const next = create();
    map.set(key, next);
    return next;
  };

  const instanceRequests = new Map<
    MonomorphizedInstanceRequest["callee"],
    Map<string, MonomorphizedInstanceRequest>
  >();
  requestedInstances.forEach((info) => {
    const byArgs = getOrCreateMap(instanceRequests, info.callee, () => new Map());
    const key = info.typeArgs.join(",");
    if (!byArgs.has(key)) {
      byArgs.set(key, info);
    }
  });

  const instances = Array.from(instanceRequests.entries())
    .flatMap(([, byArgs]) => Array.from(byArgs.values()))
    .sort((a, b) => {
      if (a.callee !== b.callee) return a.callee - b.callee;
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

    const importsByLocal = new Map<
      number,
      { moduleId: string; symbol: number }
    >();
    const importAliasesByModule = new Map<string, Map<number, number>>();
    entry.binding.imports.forEach((imp) => {
      if (!imp.target) {
        return;
      }
      importsByLocal.set(imp.local, imp.target);
      const bucket =
        importAliasesByModule.get(imp.target.moduleId) ?? new Map();
      bucket.set(imp.target.symbol, imp.local);
      importAliasesByModule.set(imp.target.moduleId, bucket);
    });

    const ctx: TypingContext = {
      symbolTable: getSymbolTable(entry),
      hir: entry.hir,
      overloads: collectOverloadOptions(
        entry.binding.overloads,
        entry.binding.importedOverloadOptions
      ),
      decls: entry.binding.decls,
      moduleId: entry.moduleId,
      packageId: entry.binding.packageId,
      moduleExports,
      dependencies,
      importsByLocal,
      importAliasesByModule,
      arena: entry.typing.arena,
      table: entry.typing.table,
      effects: entry.typing.effects,
      resolvedExprTypes: new Map(entry.typing.resolvedExprTypes),
      valueTypes: new Map(entry.typing.valueTypes),
      activeValueTypeComputations: new Set(),
      tailResumptions: new Map(entry.typing.tailResumptions),
      callResolution: {
        targets: cloneNestedMap(entry.typing.callTargets),
        typeArguments: cloneNestedMap(entry.typing.callTypeArguments),
        instanceKeys: cloneNestedMap(entry.typing.callInstanceKeys),
        traitDispatches: new Set(entry.typing.callTraitDispatches),
      },
      functions: entry.typing.functions,
      objects: entry.typing.objects,
      traits: entry.typing.traits,
      typeAliases: entry.typing.typeAliases,
      primitives: entry.typing.primitives,
      intrinsicTypes: entry.typing.intrinsicTypes,
      diagnostics: new DiagnosticEmitter(),
      memberMetadata: new Map(entry.typing.memberMetadata),
      traitImplsByNominal: new Map(entry.typing.traitImplsByNominal),
      traitImplsByTrait: new Map(entry.typing.traitImplsByTrait),
      traitMethodImpls: new Map(entry.typing.traitMethodImpls),
    };

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
