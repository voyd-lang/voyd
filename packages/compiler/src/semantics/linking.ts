import { DiagnosticEmitter } from "../diagnostics/index.js";
import { createTypingState } from "./typing/context.js";
import type { DependencySemantics, TypingContext } from "./typing/types.js";
import {
  formatFunctionInstanceKey,
  typeGenericFunctionBody,
} from "./typing/expressions/call.js";
import type { ModuleExportTable } from "./modules.js";
import type { SemanticsPipelineResult } from "./pipeline.js";
import { makeInstanceKey, type MonomorphizedInstanceInfo } from "./codegen-view/index.js";
import type { SymbolRef } from "./typing/symbol-ref.js";
import { getSymbolTable } from "./_internal/symbol-table.js";
import type { HirExprId, SymbolId, TypeId } from "./ids.js";

export const monomorphizeProgram = ({
  modules,
  semantics,
}: {
  modules: readonly SemanticsPipelineResult[];
  semantics: Map<string, SemanticsPipelineResult>;
}): {
  instances: readonly MonomorphizedInstanceInfo[];
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
      valueTypes: ReadonlyMap<SymbolId, TypeId>;
    }
  >;
} => {
  const { moduleExports, dependencies } = buildDependencyIndex(semantics);
  const typingContexts = new Map<string, TypingContext>();
  const typingContextFor = createTypingContextFactory({
    semantics,
    moduleExports,
    dependencies,
    typingContexts,
  });

  const touchedModules = new Set<string>();

  const requestedInstances: MonomorphizedInstanceInfo[] = [];

  modules.forEach((caller) => {
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

      const callee = semantics.get(importModuleId);
      const calleeCtx = callee ? typingContextFor(callee.moduleId) : undefined;
      if (!callee || !calleeCtx) {
        return;
      }

      const calleeSignature =
        callee.typing.functions.getSignature(importSymbol);
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
          callee: {
            moduleId: importModuleId,
            symbol: importSymbol,
          } satisfies SymbolRef,
          typeArgs,
          instanceKey: makeInstanceKey(
            importModuleId,
            formatFunctionInstanceKey(importSymbol, typeArgs)
          ),
        });

        const substitution = new Map(
          typeParams.map(
            (param, index) => [param.typeParam, typeArgs[index]!] as const
          )
        );
        typeGenericFunctionBody({
          symbol: importSymbol,
          signature: calleeSignature,
          substitution,
          ctx: calleeCtx,
          state: createTypingState("relaxed"),
        });
        touchedModules.add(importModuleId);
      });
    });
  });

  const instanceByKey = new Map<string, MonomorphizedInstanceInfo>();
  requestedInstances.forEach((info) => {
    instanceByKey.set(info.instanceKey, info);
  });
  const instances = Array.from(instanceByKey.values()).sort((a, b) => {
    const modOrder = a.callee.moduleId.localeCompare(
      b.callee.moduleId,
      undefined,
      {
        numeric: true,
      }
    );
    if (modOrder !== 0) return modOrder;
    if (a.callee.symbol !== b.callee.symbol)
      return a.callee.symbol - b.callee.symbol;
    return a.instanceKey.localeCompare(b.instanceKey, undefined, {
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
      valueTypes: ReadonlyMap<SymbolId, TypeId>;
    }
  >();

  touchedModules.forEach((moduleId) => {
    const ctx = typingContexts.get(moduleId);
    if (!ctx) return;
    moduleTyping.set(moduleId, {
      functionInstantiationInfo: ctx.functions.snapshotInstantiationInfo(),
      functionInstanceExprTypes: ctx.functions.snapshotInstanceExprTypes(),
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
