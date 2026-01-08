import { DiagnosticEmitter } from "../diagnostics/index.js";
import { createTypingState } from "./typing/context.js";
import type { DependencySemantics, TypingContext } from "./typing/types.js";
import { createTypeTranslation, mapDependencySymbolToLocal } from "./typing/imports.js";
import { typeGenericFunctionBody } from "./typing/expressions/call.js";
import type { ModuleExportTable } from "./modules.js";
import type { SemanticsPipelineResult } from "./pipeline.js";

export const linkProgramSemantics = ({
  modules,
  semantics,
}: {
  modules: readonly SemanticsPipelineResult[];
  semantics: Map<string, SemanticsPipelineResult>;
}): void => {
  const { moduleExports, dependencies } = buildDependencyIndex(semantics);
  const typingContexts = new Map<string, TypingContext>();
  const typingContextFor = createTypingContextFactory({
    semantics,
    moduleExports,
    dependencies,
    typingContexts,
  });

  const modulesById = new Map(modules.map((entry) => [entry.moduleId, entry] as const));
  const touchedModules = new Set<string>();

  modulesById.forEach((caller) => {
    const callerDep = dependencies.get(caller.moduleId);
    if (!callerDep) {
      return;
    }

    caller.typing.functionInstantiationInfo.forEach((instantiations, localSymbol) => {
      const metadata = (caller.symbolTable.getSymbol(localSymbol).metadata ?? {}) as
        | { import?: { moduleId?: unknown; symbol?: unknown } }
        | undefined;
      const importModuleId = metadata?.import?.moduleId;
      const importSymbol = metadata?.import?.symbol;

      if (typeof importModuleId !== "string" || typeof importSymbol !== "number") {
        return;
      }

      const callee = semantics.get(importModuleId);
      const calleeCtx = callee ? typingContextFor(callee.moduleId) : undefined;
      if (!callee || !calleeCtx) {
        return;
      }

      const calleeSignature = callee.typing.functions.getSignature(importSymbol);
      const typeParams = calleeSignature?.typeParams ?? [];
      if (!calleeSignature || typeParams.length === 0) {
        return;
      }

      const translateTypeArg = createTypeTranslation({
        sourceArena: caller.typing.arena,
        targetArena: calleeCtx.arena,
        sourceEffects: caller.typing.effects,
        targetEffects: calleeCtx.effects,
        mapSymbol: (symbol) =>
          mapDependencySymbolToLocal({
            owner: symbol,
            dependency: callerDep,
            ctx: calleeCtx,
            allowUnexported: true,
          }),
      });

      instantiations.forEach((typeArgs) => {
        if (typeArgs.length !== typeParams.length) {
          return;
        }

        const translated = typeArgs.map((arg) => translateTypeArg(arg));
        const substitution = new Map(
          typeParams.map((param, index) => [param.typeParam, translated[index]!] as const)
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

  touchedModules.forEach((moduleId) => {
    const entry = semantics.get(moduleId);
    const ctx = typingContexts.get(moduleId);
    if (!entry || !ctx) {
      return;
    }
    entry.typing.functionInstantiationInfo = ctx.functions.snapshotInstantiationInfo();
    entry.typing.functionInstances = ctx.functions.snapshotInstances();
    entry.typing.functionInstanceExprTypes = ctx.functions.snapshotInstanceExprTypes();
    entry.typing.valueTypes = new Map(ctx.valueTypes);
  });
};

const buildDependencyIndex = (
  semantics: Map<string, SemanticsPipelineResult>
): {
  moduleExports: Map<string, ModuleExportTable>;
  dependencies: Map<string, DependencySemantics>;
} => {
  const moduleExports = new Map<string, ModuleExportTable>(
    Array.from(semantics.entries()).map(([id, entry]) => [id, entry.exports])
  );
  const dependencies = new Map<string, DependencySemantics>(
    Array.from(semantics.entries()).map(([id, entry]) => [
      id,
      {
        moduleId: entry.moduleId,
        packageId: entry.binding.packageId,
        symbolTable: entry.symbolTable,
        hir: entry.hir,
        typing: entry.typing,
        decls: entry.binding.decls,
        overloads: collectOverloadOptions(
          entry.binding.overloads,
          entry.binding.importedOverloadOptions
        ),
        exports: entry.exports,
      },
    ])
  );

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

    const importsByLocal = new Map<number, { moduleId: string; symbol: number }>();
    const importAliasesByModule = new Map<string, Map<number, number>>();
    entry.binding.imports.forEach((imp) => {
      if (!imp.target) {
        return;
      }
      importsByLocal.set(imp.local, imp.target);
      const bucket = importAliasesByModule.get(imp.target.moduleId) ?? new Map();
      bucket.set(imp.target.symbol, imp.local);
      importAliasesByModule.set(imp.target.moduleId, bucket);
    });

    const ctx: TypingContext = {
      symbolTable: entry.symbolTable,
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
          Array.from(entry.typing.callTargets.entries()).map(([exprId, targets]) => [
            exprId,
            new Map(targets),
          ])
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
