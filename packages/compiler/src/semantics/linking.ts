import { DiagnosticEmitter } from "../diagnostics/index.js";
import { createTypingState } from "./typing/context.js";
import type { DependencySemantics, TypingContext } from "./typing/types.js";
import {
  typeGenericFunctionBody,
} from "./typing/expressions/call.js";
import type { ModuleExportTable } from "./modules.js";
import type { SemanticsPipelineResult } from "./pipeline.js";
import type { MonomorphizedInstanceRequest } from "./codegen-view/index.js";
import { getSymbolTable } from "./_internal/symbol-table.js";
import type { HirExprId, SymbolId, TypeId } from "./ids.js";
import { buildProgramSymbolArena, type SymbolRef as ProgramSymbolRef } from "./program-symbol-arena.js";
import { createCanonicalSymbolRefResolver } from "./canonical-symbol-ref.js";
import type { SymbolRef as TypingSymbolRef } from "./typing/symbol-ref.js";

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
        SymbolId,
        ReadonlyMap<string, readonly TypeId[]>
      >;
      functionInstanceExprTypes: ReadonlyMap<
        string,
        ReadonlyMap<HirExprId, TypeId>
      >;
      callTargets: ReadonlyMap<HirExprId, ReadonlyMap<string, TypingSymbolRef>>;
      callTypeArguments: ReadonlyMap<HirExprId, readonly TypeId[]>;
      callInstanceKeys: ReadonlyMap<HirExprId, string>;
      callTraitDispatches: ReadonlySet<HirExprId>;
      valueTypes: ReadonlyMap<SymbolId, TypeId>;
    }
  >;
} => {
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

  modules.forEach((caller) => {
    const callTargets = caller.typing.callTargets;
    const callTypeArguments = caller.typing.callTypeArguments;

    callTargets.forEach((targets, callId) => {
      const typeArgs = callTypeArguments.get(callId);
      if (!typeArgs || typeArgs.length === 0) {
        return;
      }
      targets.forEach((targetRef) => {
        if (targetRef.moduleId === caller.moduleId) {
          return;
        }
        const canonicalCallee = canonicalSymbolRef({
          moduleId: targetRef.moduleId,
          symbol: targetRef.symbol,
        });
        const callee = semantics.get(canonicalCallee.moduleId);
        const calleeCtx = callee ? typingContextFor(canonicalCallee.moduleId) : undefined;
        if (!callee || !calleeCtx) {
          return;
        }
        const calleeSignature =
          callee.typing.functions.getSignature(canonicalCallee.symbol);
        const typeParams = calleeSignature?.typeParams ?? [];
        if (!calleeSignature || typeParams.length === 0) {
          return;
        }
        if (typeArgs.length !== typeParams.length) {
          return;
        }
        requestedInstances.push({
          callee: programSymbols.idOf(canonicalCallee),
          typeArgs,
        });
        const substitution = new Map(
          typeParams.map(
            (param, index) => [param.typeParam, typeArgs[index]!] as const
          )
        );
        typeGenericFunctionBody({
          symbol: canonicalCallee.symbol,
          signature: calleeSignature,
          substitution,
          ctx: calleeCtx,
          state: createTypingState("relaxed"),
        });
        touchedModules.add(canonicalCallee.moduleId);
      });
    });

    const sortedLocalSymbols = Array.from(
      caller.typing.functionInstantiationInfo.keys()
    ).sort((a, b) => a - b);
    sortedLocalSymbols.forEach((localSymbol) => {
      const instantiations =
        caller.typing.functionInstantiationInfo.get(localSymbol);
      if (!instantiations) {
        return;
      }
      const metadata = (getSymbolTable(caller).getSymbol(localSymbol)
        .metadata ?? {}) as
        | { import?: { moduleId?: unknown; symbol?: unknown } }
        | undefined;
      const importModuleId = metadata?.import?.moduleId;
      const importSymbol = metadata?.import?.symbol;

      if (
        typeof importModuleId !== "string" ||
        typeof importSymbol !== "number"
      ) {
        return;
      }

      const canonicalCallee = canonicalSymbolRef({
        moduleId: importModuleId,
        symbol: importSymbol,
      });
      const callee = semantics.get(canonicalCallee.moduleId);
      const calleeCtx = callee ? typingContextFor(callee.moduleId) : undefined;
      if (!callee || !calleeCtx) {
        return;
      }

      const calleeSignature =
        callee.typing.functions.getSignature(canonicalCallee.symbol);
      const typeParams = calleeSignature?.typeParams ?? [];
      if (!calleeSignature || typeParams.length === 0) {
        return;
      }

      const sortedInstantiations = Array.from(instantiations.entries()).sort(
        ([a], [b]) => a.localeCompare(b, undefined, { numeric: true })
      );
      sortedInstantiations.forEach(([, typeArgs]) => {
        if (typeArgs.length !== typeParams.length) {
          return;
        }

        requestedInstances.push({
          callee: programSymbols.idOf(canonicalCallee),
          typeArgs,
        });

        const substitution = new Map(
          typeParams.map(
            (param, index) => [param.typeParam, typeArgs[index]!] as const
          )
        );
        typeGenericFunctionBody({
          symbol: canonicalCallee.symbol,
          signature: calleeSignature,
          substitution,
          ctx: calleeCtx,
          state: createTypingState("relaxed"),
        });
        touchedModules.add(canonicalCallee.moduleId);
      });
    });
  });

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
        SymbolId,
        ReadonlyMap<string, readonly TypeId[]>
      >;
      functionInstanceExprTypes: ReadonlyMap<
        string,
        ReadonlyMap<HirExprId, TypeId>
      >;
      callTargets: ReadonlyMap<HirExprId, ReadonlyMap<string, TypingSymbolRef>>;
      callTypeArguments: ReadonlyMap<HirExprId, readonly TypeId[]>;
      callInstanceKeys: ReadonlyMap<HirExprId, string>;
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
      callTargets: new Map(
        Array.from(ctx.callResolution.targets.entries()).map(([exprId, targets]) => [
          exprId,
          new Map(targets),
        ])
      ),
      callTypeArguments: new Map(ctx.callResolution.typeArguments),
      callInstanceKeys: new Map(ctx.callResolution.instanceKeys),
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
      tailResumptions: new Map(entry.typing.tailResumptions),
      callResolution: {
        targets: new Map(
          Array.from(entry.typing.callTargets.entries()).map(
            ([exprId, targets]) => [exprId, new Map(targets)]
          )
        ),
        typeArguments: new Map(entry.typing.callTypeArguments),
        instanceKeys: new Map(entry.typing.callInstanceKeys),
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
