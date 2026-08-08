import { type Form } from "../../../parser/index.js";
import type {
  SurfaceModuleItem,
  SurfaceModuleView,
} from "../../../parser/surface/index.js";
import { toSourceSpan } from "../../../parser/surface/utils.js";
import { bindFunctionDecl } from "./function.js";
import { bindModuleLetDecl } from "./module-let.js";
import { bindObjectDecl } from "./object.js";
import { bindTypeAlias, seedTypeAliasNamespaces } from "./type-alias.js";
import { bindTraitDecl } from "./trait.js";
import { bindImplDecl, flushPendingStaticMethods } from "./impl.js";
import { bindEffectDecl } from "./effect.js";
import { flushPendingHandlerOperationBindings } from "./expressions.js";
import type {
  BindingContext,
  BindingResult,
  BoundUseEntry,
  BoundImport,
} from "../types.js";
import {
  diagnosticFromCode,
  type Diagnostic,
  type DiagnosticParams,
} from "../../../diagnostics/index.js";
import { modulePathToString } from "../../../modules/path.js";
import type { ModuleNode, ModulePath } from "../../../modules/types.js";
import type { NormalizedUseEntry } from "../../../parser/surface/index.js";
import { matchesDependencyPath } from "../../../modules/resolve.js";
import {
  type HirVisibility,
  moduleVisibility,
  packageVisibility,
} from "../../hir/index.js";
import type { SymbolKind } from "../../binder/index.js";
import type {
  ModuleExportEntry,
  ModuleExportSurfaceEntry,
} from "../../modules.js";
import {
  firstInstanceMemberOwner,
  moduleNamespaceExportEntry,
} from "../../modules.js";
import type { SourceSpan, SymbolId } from "../../ids.js";
import { BinderScopeTracker } from "./scope-tracker.js";
import {
  importableMetadataFrom,
  importedModuleExplicitStdSubmoduleFrom,
  importedModuleIdFrom,
} from "../../imports/metadata.js";
import { findModuleNamespaceNameCollision } from "../name-collisions.js";
import {
  canAccessExport,
  canAccessSymbolVisibility,
  stdPkgExportsFor,
} from "../export-visibility.js";
import {
  enumNamespaceMemberNamesFromMetadata,
  enumVariantTypeTargetsFromAliasTarget,
  importedSymbolTargetFromMetadata,
} from "../../enum-namespace.js";
import { isPackageRootModule } from "../../packages.js";
import {
  requireModuleHeader,
  requireModuleSurface,
} from "../../../modules/views.js";
import { resolveNominalTypeSymbol } from "../../nominal-type-target.js";

export const bindModule = (
  surface: SurfaceModuleView,
  ctx: BindingContext,
): void => {
  const tracker = new BinderScopeTracker(ctx.symbolTable);
  for (const item of surface.items) {
    const entry = surfaceItemForm(item);
    if (!ctx.includeTests && isTestEntry(entry)) {
      continue;
    }

    if (item.kind === "use") {
      bindUseDecl(
        {
          form: item.form,
          visibility:
            item.visibility === "pub"
              ? packageVisibility()
              : moduleVisibility(),
          entries: item.entries,
        },
        ctx,
      );
      continue;
    }

    if (item.kind === "macro") {
      continue;
    }

    if (item.kind === "inline-module") {
      continue;
    }

    if (item.kind === "unsupported-module") {
      ctx.diagnostics.push(
        diagnosticFromCode({
          code: "BD0005",
          params: { kind: "unsupported-mod-decl" },
          span: toSourceSpan(entry),
        }),
      );
      continue;
    }
    if (item.kind === "function") {
      bindFunctionDecl(item.declaration, ctx, tracker);
      continue;
    }

    if (item.kind === "module-let") {
      bindModuleLetDecl(item.declaration, ctx, tracker);
      continue;
    }

    if (item.kind === "object") {
      bindObjectDecl(item.declaration, ctx, tracker);
      continue;
    }

    if (item.kind === "type-alias") {
      bindTypeAlias(item.declaration, ctx, tracker);
      continue;
    }

    if (item.kind === "trait") {
      bindTraitDecl(item.declaration, ctx, tracker);
      continue;
    }

    if (item.kind === "impl") {
      bindImplDecl(item.declaration, ctx, tracker);
      continue;
    }

    if (item.kind === "effect") {
      bindEffectDecl(item.declaration, ctx, tracker);
      continue;
    }
  }

  flushPendingHandlerOperationBindings(ctx, tracker);
  seedTypeAliasNamespaces(ctx);
  flushPendingStaticMethods(ctx);
  validateEffectOperationSelectionValueConflicts(ctx);

  if (tracker.depth() !== 1) {
    throw new Error("binder scope stack imbalance after traversal");
  }
};

const surfaceItemForm = (item: SurfaceModuleItem): Form =>
  "form" in item ? item.form : item.declaration.form;

type ParsedUseEntry = NormalizedUseEntry;

type ParsedUseDecl = {
  form: Form;
  visibility: HirVisibility;
  entries: readonly ParsedUseEntry[];
};

const isTestEntry = (form: Form): boolean => {
  const attributes = form.attributes as { test?: unknown } | undefined;
  return Boolean(attributes?.test);
};

const bindUseDecl = (decl: ParsedUseDecl, ctx: BindingContext): void => {
  const entries = decl.entries.map((entry) =>
    resolveUseEntry({ entry, decl, ctx }),
  );
  ctx.uses.push({
    form: decl.form,
    visibility: decl.visibility,
    entries,
    order: ctx.nextModuleIndex++,
  });
};

const resolveUseEntry = ({
  entry,
  decl,
  ctx,
}: {
  entry: ParsedUseEntry;
  decl: ParsedUseDecl;
  ctx: BindingContext;
}): BoundUseEntry => {
  if (!entry.hasExplicitPrefix) {
    const implicitUse = resolveImplicitNamespaceUseEntry({ entry, decl, ctx });
    if (implicitUse) {
      return implicitUse;
    }

    recordImportDiagnostic({
      params: {
        kind: "missing-path-prefix",
        path: entry.path,
      },
      span: entry.span,
      ctx,
    });
    return {
      path: entry.path,
      span: entry.span,
      selectionKind: entry.selectionKind,
      targetName: entry.targetName,
      alias: entry.alias,
      imports: [],
    };
  }

  let dependencyPath = resolveDependencyPath({ entry, ctx });
  if (!dependencyPath) {
    const effectNamespaceUse = resolveQualifiedEffectNamespaceUseEntry({
      entry,
      decl,
      ctx,
    });
    if (effectNamespaceUse) {
      return effectNamespaceUse;
    }
  }
  let blockedStdImport = false;

  if (dependencyPath && isStdImportBlocked({ dependencyPath, entry, ctx })) {
    recordImportDiagnostic({
      params: {
        kind: "module-unavailable",
        moduleId: modulePathToString(dependencyPath),
      },
      span: entry.span,
      ctx,
    });
    dependencyPath = undefined;
    blockedStdImport = true;
  }

  const moduleId = dependencyPath
    ? modulePathToString(dependencyPath)
    : undefined;
  if (!moduleId && !blockedStdImport) {
    recordImportDiagnostic({
      params: { kind: "unresolved-use-path", path: entry.path },
      span: entry.span,
      ctx,
    });
  }

  const imports =
    entry.selectionKind === "module"
      ? declareModuleImport({
          moduleId,
          alias: entry.alias ?? entry.path.at(-1),
          explicitlyTargetsStdSubmodule: isExplicitStdSubmoduleEntry(entry),
          ctx,
          span: entry.span,
          declaredAt: decl.form,
          visibility: decl.visibility,
        })
      : moduleId
        ? bindImportsFromModule({
            moduleId,
            entry,
            ctx,
            declaredAt: decl.form,
            visibility: decl.visibility,
          })
        : [];

  return {
    path: entry.path,
    moduleId,
    span: entry.span,
    selectionKind: entry.selectionKind,
    targetName: entry.targetName,
    alias: entry.alias,
    imports: imports ?? [],
  };
};

const resolveImplicitNamespaceUseEntry = ({
  entry,
  decl,
  ctx,
}: {
  entry: ParsedUseEntry;
  decl: ParsedUseDecl;
  ctx: BindingContext;
}): BoundUseEntry | undefined => {
  if (entry.moduleSegments.length !== 1) {
    return undefined;
  }
  const namespaceName = entry.moduleSegments[0];
  if (!namespaceName) {
    return undefined;
  }

  const namespaceSymbol = ctx.symbolTable.resolve(
    namespaceName,
    ctx.symbolTable.rootScope,
  );
  if (typeof namespaceSymbol !== "number") {
    return undefined;
  }
  const namespaceRecord = ctx.symbolTable.getSymbol(namespaceSymbol);

  if (namespaceRecord.kind === "module") {
    const namespaceMetadata = namespaceRecord.metadata as
      | Record<string, unknown>
      | undefined;
    const moduleId = importedModuleIdFrom(namespaceMetadata);
    if (!moduleId) {
      return undefined;
    }
    const explicitlyTargetsStdSubmodule =
      importedModuleExplicitStdSubmoduleFrom(namespaceMetadata) ?? false;
    const imports =
      entry.selectionKind === "module"
        ? declareModuleImport({
            moduleId,
            alias: entry.alias ?? entry.path.at(-1),
            explicitlyTargetsStdSubmodule,
            ctx,
            span: entry.span,
            declaredAt: decl.form,
            visibility: decl.visibility,
          })
        : bindImportsFromModule({
            moduleId,
            entry: { ...entry, hasExplicitPrefix: true },
            explicitlyTargetsStdSubmodule,
            ctx,
            declaredAt: decl.form,
            visibility: decl.visibility,
          });
    return {
      path: entry.path,
      moduleId,
      span: entry.span,
      selectionKind: entry.selectionKind,
      targetName: entry.targetName,
      alias: entry.alias,
      imports: imports ?? [],
    };
  }

  if (namespaceRecord.kind === "effect") {
    return resolveEffectNamespaceUseEntry({
      namespaceSymbol,
      entry,
      decl,
      ctx,
    });
  }

  if (namespaceRecord.kind !== "type") {
    return undefined;
  }
  const explicitlyTargetsStdSubmodule =
    importedModuleExplicitStdSubmoduleFrom(
      namespaceRecord.metadata as Record<string, unknown> | undefined,
    ) ?? false;

  const importedTarget = importedSymbolTargetFromMetadata(
    namespaceRecord.metadata as Record<string, unknown> | undefined,
  );
  if (!importedTarget) {
    return resolveLocalTypeNamespaceUseEntry({
      namespaceSymbol,
      entry,
      decl,
      ctx,
    });
  }

  const dependency = ctx.dependencies.get(importedTarget.moduleId);
  const variantMembers = new Map(
    Array.from(ctx.staticMethods.get(namespaceSymbol)?.entries() ?? [])
      .map(
        ([name, symbols]) =>
          [
            name,
            new Set(
              Array.from(symbols).filter((symbol) => {
                const record = ctx.symbolTable.getSymbol(symbol);
                const entity = (
                  record.metadata as { entity?: unknown } | undefined
                )?.entity;
                return record.kind === "type" && entity === "object";
              }),
            ),
          ] as const,
      )
      .filter(([, symbols]) => symbols.size > 0),
  );
  if (!dependency || variantMembers.size === 0) {
    return undefined;
  }

  let ambiguityReported = false;
  const visibleObjectExportFor = (
    variantName: string,
  ): ModuleExportEntry | undefined => {
    const symbols = variantMembers.get(variantName);
    if (!symbols) {
      return undefined;
    }
    const canonicalCandidates = new Map(
      Array.from(symbols).map((symbol) => {
        const canonical = canonicalBindingSymbol({
          moduleId: ctx.module.id,
          symbol,
          binding: ctx,
        });
        return [
          `${canonical.moduleId}:${canonical.symbol}`,
          canonical,
        ] as const;
      }),
    );
    if (canonicalCandidates.size > 1) {
      ambiguityReported = true;
      recordImportDiagnostic({
        params: {
          kind: "ambiguous-namespace-member",
          namespace: namespaceRecord.name,
          member: variantName,
        },
        span: entry.span,
        ctx,
      });
      return undefined;
    }
    const canonical = Array.from(canonicalCandidates.values())[0];
    if (!canonical) {
      return undefined;
    }
    const exported = Array.from(
      ctx.moduleExports.get(canonical.moduleId)?.values() ?? [],
    ).find((candidate) => candidate.symbol === canonical.symbol);
    if (!exported) {
      return undefined;
    }
    const exportedRecord = canonical.binding.symbolTable.getSymbol(
      canonical.symbol,
    );
    const metadata = exportedRecord.metadata as { entity?: string } | undefined;
    if (exportedRecord.kind !== "type" || metadata?.entity !== "object") {
      return undefined;
    }
    if (
      !canAccessExport({
        exported,
        moduleId: canonical.moduleId,
        ctx,
        explicitlyTargetsStdSubmodule,
      })
    ) {
      return undefined;
    }
    return exported;
  };

  const imports = (() => {
    if (entry.selectionKind === "all") {
      return Array.from(variantMembers.keys()).flatMap((variantName) => {
        const exported = visibleObjectExportFor(variantName);
        if (!exported) {
          return [];
        }
        return declareImportedSymbol({
          exported,
          alias: variantName,
          explicitlyTargetsStdSubmodule,
          ctx,
          declaredAt: decl.form,
          span: entry.span,
          visibility: decl.visibility,
        });
      });
    }

    const targetName = entry.targetName ?? entry.alias;
    if (!targetName) {
      recordImportDiagnostic({
        params: { kind: "missing-target" },
        span: entry.span,
        ctx,
      });
      return [];
    }

    const exported = visibleObjectExportFor(targetName);
    if (!exported) {
      if (ambiguityReported) {
        return [];
      }
      recordImportDiagnostic({
        params: {
          kind: "missing-export",
          moduleId: importedTarget.moduleId,
          target: targetName,
        },
        span: entry.span,
        ctx,
      });
      return [];
    }

    return declareImportedSymbol({
      exported,
      alias: entry.alias ?? targetName,
      explicitlyTargetsStdSubmodule,
      ctx,
      declaredAt: decl.form,
      span: entry.span,
      visibility: decl.visibility,
    });
  })();

  return {
    path: entry.path,
    moduleId: importedTarget.moduleId,
    span: entry.span,
    selectionKind: entry.selectionKind,
    targetName: entry.targetName,
    alias: entry.alias,
    imports,
  };
};

const resolveQualifiedEffectNamespaceUseEntry = ({
  entry,
  decl,
  ctx,
}: {
  entry: ParsedUseEntry;
  decl: ParsedUseDecl;
  ctx: BindingContext;
}): BoundUseEntry | undefined => {
  if (entry.moduleSegments.length < 2) {
    return undefined;
  }
  const namespaceName = entry.moduleSegments.at(-1);
  if (!namespaceName) {
    return undefined;
  }
  const parentSegments = entry.moduleSegments.slice(0, -1);
  const parentEntry = {
    ...entry,
    moduleSegments: parentSegments,
    path: parentSegments,
    targetName: undefined,
    alias: parentSegments.at(-1),
    selectionKind: "module" as const,
  };
  const dependencyPath = resolveDependencyPath({ entry: parentEntry, ctx });
  if (!dependencyPath) {
    return undefined;
  }
  const moduleId = modulePathToString(dependencyPath);
  const exportedEffect = ctx.moduleExports.get(moduleId)?.get(namespaceName);
  if (!exportedEffect || exportedEffect.kind !== "effect") {
    return undefined;
  }
  const explicitlyTargetsStdSubmodule =
    isExplicitStdSubmoduleEntry(parentEntry);
  if (
    !canAccessExport({
      exported: exportedEffect,
      moduleId,
      ctx,
      explicitlyTargetsStdSubmodule,
    })
  ) {
    recordOutOfScopeExportDiagnostic({
      exported: exportedEffect,
      moduleId,
      targetName: namespaceName,
      span: entry.span,
      ctx,
    });
    return {
      path: entry.path,
      moduleId,
      span: entry.span,
      selectionKind: entry.selectionKind,
      targetName: entry.targetName,
      alias: entry.alias,
      imports: [],
    };
  }

  const importedTarget = canonicalExportTarget({
    exported: exportedEffect,
    ctx,
  });
  if (!importedTarget) {
    return undefined;
  }
  const imports = bindEffectNamespaceOperations({
    effectModuleId: importedTarget.moduleId,
    effectSymbol: importedTarget.symbol,
    entry,
    declaredAt: decl.form,
    visibility: decl.visibility,
    explicitlyTargetsStdSubmodule,
    ctx,
  });
  return {
    path: entry.path,
    moduleId,
    span: entry.span,
    selectionKind: entry.selectionKind,
    targetName: entry.targetName,
    alias: entry.alias,
    imports,
  };
};

const resolveEffectNamespaceUseEntry = ({
  namespaceSymbol,
  entry,
  decl,
  ctx,
}: {
  namespaceSymbol: SymbolId;
  entry: ParsedUseEntry;
  decl: ParsedUseDecl;
  ctx: BindingContext;
}): BoundUseEntry | undefined => {
  const namespaceRecord = ctx.symbolTable.getSymbol(namespaceSymbol);
  const importedTarget = importedSymbolTargetFromMetadata(
    namespaceRecord.metadata as Record<string, unknown> | undefined,
  );
  const effectModuleId = importedTarget?.moduleId ?? ctx.module.id;
  const effectSymbol = importedTarget?.symbol ?? namespaceSymbol;
  const imports = bindEffectNamespaceOperations({
    effectModuleId,
    effectSymbol,
    entry,
    declaredAt: decl.form,
    visibility: decl.visibility,
    explicitlyTargetsStdSubmodule:
      importedModuleExplicitStdSubmoduleFrom(
        namespaceRecord.metadata as Record<string, unknown> | undefined,
      ) ?? false,
    ctx,
  });
  if (
    imports.length === 0 &&
    !effectDeclFor({ effectModuleId, effectSymbol, ctx })
  ) {
    return undefined;
  }
  return {
    path: entry.path,
    moduleId: effectModuleId,
    span: entry.span,
    selectionKind: entry.selectionKind,
    targetName: entry.targetName,
    alias: entry.alias,
    imports,
  };
};

const bindEffectNamespaceOperations = ({
  effectModuleId,
  effectSymbol,
  entry,
  declaredAt,
  visibility,
  explicitlyTargetsStdSubmodule,
  ctx,
}: {
  effectModuleId: string;
  effectSymbol: SymbolId;
  entry: ParsedUseEntry;
  declaredAt: Form;
  visibility: HirVisibility;
  explicitlyTargetsStdSubmodule: boolean;
  ctx: BindingContext;
}): BoundImport[] => {
  const effect = effectDeclFor({ effectModuleId, effectSymbol, ctx });
  if (!effect) {
    return [];
  }
  const selectedNames =
    entry.selectionKind === "all"
      ? Array.from(
          new Set(effect.operations.map((operation) => operation.name)),
        )
      : [entry.targetName ?? entry.alias].filter(
          (name): name is string => typeof name === "string",
        );
  const availableNames = new Set(
    effect.operations.map((operation) => operation.name),
  );
  const missingName = selectedNames.find((name) => !availableNames.has(name));
  if (missingName) {
    recordImportDiagnostic({
      params: {
        kind: "missing-export",
        moduleId: `${effectModuleId}::${effect.name}`,
        target: missingName,
      },
      span: entry.span,
      ctx,
    });
    return [];
  }

  if (effectModuleId === ctx.module.id) {
    return selectedNames.flatMap((name) => {
      const operations = effect.operations.filter(
        (operation) => operation.name === name,
      );
      const importedName = entry.alias ?? name;
      const moduleConflict = findModuleNamespaceNameCollision({
        name: importedName,
        scope: ctx.symbolTable.rootScope,
        incomingKind: "effect-op",
        ctx,
      });
      if (moduleConflict) {
        recordImportNameConflict({
          name: importedName,
          incomingKind: "effect-op",
          existingKind: moduleConflict.kind,
          effectName: effect.name,
          span: entry.span,
          previousSpan: moduleConflict.span,
          ctx,
        });
        return [];
      }
      const conflict = findEffectOperationSelectionConflict({
        name: importedName,
        incomingKind: "effect-op",
        incomingModuleId: effectModuleId,
        incomingSymbols: operations.map((operation) => operation.symbol),
        fallbackSpan: entry.span,
        ctx,
      });
      if (conflict) {
        recordImportNameConflict({
          name: importedName,
          incomingKind: "effect-op",
          existingKind: conflict.kind,
          effectName: effect.name,
          span: entry.span,
          previousSpan: conflict.span,
          ctx,
        });
        return [];
      }
      return operations.map((operation) => {
        const operationRecord = ctx.symbolTable.getSymbol(operation.symbol);
        const operationMetadata = (operationRecord.metadata ?? {}) as {
          unqualifiedEffectOperationNames?: readonly string[];
        };
        ctx.symbolTable.setSymbolMetadata(operation.symbol, {
          unqualifiedEffectOperationNames: Array.from(
            new Set([
              ...(operationMetadata.unqualifiedEffectOperationNames ?? []),
              importedName,
            ]),
          ),
        });
        if (importedName !== operationRecord.name) {
          ctx.symbolTable.bindAlias({
            name: importedName,
            symbol: operation.symbol,
          });
        }
        return {
          name: importedName,
          local: operation.symbol,
          visibility,
          span: entry.span,
        };
      });
    });
  }

  const dependency = ctx.dependencies.get(effectModuleId);
  if (!dependency) {
    return [];
  }
  return selectedNames.flatMap((name) => {
    const operation = effect.operations.find(
      (candidate) => candidate.name === name,
    );
    if (!operation) {
      return [];
    }
    return declareImportedSymbol({
      exported: {
        name,
        symbol: operation.symbol,
        symbols: [operation.symbol],
        moduleId: effectModuleId,
        modulePath: dependency.modulePath,
        packageId: dependency.packageId,
        kind: "effect-op",
        visibility: effect.visibility,
      },
      alias: entry.alias ?? name,
      explicitlyTargetsStdSubmodule,
      effectName: effect.name,
      ctx,
      declaredAt,
      span: entry.span,
      visibility,
    });
  });
};

const validateEffectOperationSelectionValueConflicts = (
  ctx: BindingContext,
): void => {
  ctx.uses.forEach((use) => {
    use.entries.forEach((entry) => {
      const effectOperationImports = entry.imports.filter(
        (imported) =>
          ctx.symbolTable.getSymbol(imported.local).kind === "effect-op",
      );
      const importedNames = new Set(
        effectOperationImports.map((imported) => imported.name),
      );
      importedNames.forEach((name) => {
        const valueConflict = Array.from(
          ctx.symbolTable.symbolsInScope(ctx.symbolTable.rootScope),
        )
          .map((symbol) => ctx.symbolTable.getSymbol(symbol))
          .find((record) => record.kind === "value" && record.name === name);
        if (!valueConflict) {
          return;
        }
        const syntax = ctx.syntaxByNode.get(valueConflict.declaredAt);
        recordImportNameConflict({
          name,
          incomingKind: "effect-op",
          existingKind: "value",
          effectName: effectNameForImportedOperations(
            effectOperationImports,
            ctx,
          ),
          span: entry.span,
          previousSpan: syntax ? toSourceSpan(syntax) : entry.span,
          ctx,
        });
      });
    });
  });
};

const effectDeclFor = ({
  effectModuleId,
  effectSymbol,
  ctx,
}: {
  effectModuleId: string;
  effectSymbol: SymbolId;
  ctx: BindingContext;
}) =>
  effectModuleId === ctx.module.id
    ? ctx.decls.getEffect(effectSymbol)
    : ctx.dependencies.get(effectModuleId)?.decls.getEffect(effectSymbol);

const canonicalExportTarget = ({
  exported,
  ctx,
}: {
  exported: ModuleExportEntry;
  ctx: BindingContext;
}): { moduleId: string; symbol: SymbolId } | undefined => {
  const dependency = ctx.dependencies.get(exported.moduleId);
  if (!dependency) {
    return undefined;
  }
  const sourceMetadata = dependency.symbolTable.getSymbol(
    exported.symbol,
  ).metadata;
  return (
    importedSymbolTargetFromMetadata(
      sourceMetadata as Record<string, unknown> | undefined,
    ) ?? { moduleId: exported.moduleId, symbol: exported.symbol }
  );
};

const findEffectOperationSelectionConflict = ({
  name,
  incomingKind,
  incomingModuleId,
  incomingSymbols,
  fallbackSpan,
  ctx,
}: {
  name: string;
  incomingKind: SymbolKind;
  incomingModuleId: string;
  incomingSymbols: readonly SymbolId[];
  fallbackSpan: SourceSpan;
  ctx: BindingContext;
}): { kind: SymbolKind; span: SourceSpan; effectName?: string } | undefined => {
  const incoming = new Set(incomingSymbols);
  for (const symbol of ctx.symbolTable.symbolsInScope(
    ctx.symbolTable.rootScope,
  )) {
    if (incoming.has(symbol)) {
      continue;
    }
    const record = ctx.symbolTable.getSymbol(symbol);
    if (record.kind !== "value" && record.kind !== "effect-op") {
      continue;
    }
    if (incomingKind !== "effect-op" && record.kind !== "effect-op") {
      continue;
    }
    const metadata = (record.metadata ?? {}) as {
      import?: { moduleId?: unknown; symbol?: unknown };
      qualifiedOnlyEffectOperation?: unknown;
      unqualifiedEffectOperationNames?: readonly string[];
    };
    const isExposedEffectOperation =
      record.kind !== "effect-op" ||
      (metadata.import !== undefined &&
        metadata.qualifiedOnlyEffectOperation !== true) ||
      metadata.unqualifiedEffectOperationNames?.includes(name) === true;
    if (!isExposedEffectOperation) {
      continue;
    }
    const exposesName =
      record.name === name ||
      metadata.unqualifiedEffectOperationNames?.includes(name) === true;
    if (!exposesName) {
      continue;
    }
    const belongsToIncomingGroup =
      metadata.import?.moduleId === incomingModuleId &&
      typeof metadata.import.symbol === "number" &&
      incoming.has(metadata.import.symbol);
    if (belongsToIncomingGroup) {
      continue;
    }
    const syntax = ctx.syntaxByNode.get(record.declaredAt);
    return {
      kind: record.kind,
      span: syntax ? toSourceSpan(syntax) : fallbackSpan,
      ...(record.kind === "effect-op"
        ? { effectName: effectNameForEffectOperationSymbol(symbol, ctx) }
        : {}),
    };
  }
  return undefined;
};

const effectNameForImportedOperations = (
  operations: readonly BoundImport[],
  ctx: BindingContext,
): string | undefined =>
  operations
    .map((operation) =>
      effectNameForEffectOperationSymbol(operation.local, ctx),
    )
    .find((name): name is string => typeof name === "string");

const effectNameForEffectOperationSymbol = (
  symbol: SymbolId,
  ctx: BindingContext,
): string | undefined => {
  const local = ctx.decls.getEffectOperation(symbol);
  if (local) {
    return local.effect.name;
  }
  const imported = importedSymbolTargetFromMetadata(
    ctx.symbolTable.getSymbol(symbol).metadata as
      | Record<string, unknown>
      | undefined,
  );
  return imported
    ? ctx.dependencies
        .get(imported.moduleId)
        ?.decls.getEffectOperation(imported.symbol)?.effect.name
    : undefined;
};

const resolveLocalTypeNamespaceUseEntry = ({
  namespaceSymbol,
  entry,
  decl,
  ctx,
}: {
  namespaceSymbol: SymbolId;
  entry: ParsedUseEntry;
  decl: ParsedUseDecl;
  ctx: BindingContext;
}): BoundUseEntry | undefined => {
  const namespaceMembers = collectLocalTypeNamespaceMembers({
    namespaceSymbol,
    ctx,
  });
  if (namespaceMembers.length === 0) {
    return undefined;
  }

  let ambiguityReported = false;
  const localVariant = (name: string): BoundImport | undefined => {
    const candidates = new Map<string, SymbolId>();
    namespaceMembers
      .filter((member) => member.name === name)
      .forEach((member) => {
        const key = canonicalBindingSymbolKey({
          moduleId: ctx.module.id,
          symbol: member.symbol,
          binding: ctx,
        });
        candidates.set(key, member.symbol);
      });
    if (candidates.size === 0) {
      return undefined;
    }
    if (candidates.size > 1) {
      ambiguityReported = true;
      recordImportDiagnostic({
        params: {
          kind: "ambiguous-namespace-member",
          namespace: ctx.symbolTable.getSymbol(namespaceSymbol).name,
          member: name,
        },
        span: entry.span,
        ctx,
      });
      return undefined;
    }
    const symbol = Array.from(candidates.values())[0]!;
    const record = ctx.symbolTable.getSymbol(symbol);
    const metadata = record.metadata as { entity?: unknown } | undefined;
    if (record.kind !== "type" || metadata?.entity !== "object") {
      return undefined;
    }
    const importedName = entry.alias ?? name;
    if (record.scope === ctx.symbolTable.rootScope && record.name === name) {
      if (importedName !== name || record.bindingIdentity !== undefined) {
        const importNameCollision = findModuleNamespaceNameCollision({
          name: importedName,
          scope: ctx.symbolTable.rootScope,
          incomingKind: record.kind,
          ctx,
        });
        if (importNameCollision) {
          recordImportNameConflict({
            name: importedName,
            incomingKind: record.kind,
            existingKind: importNameCollision.kind,
            span: entry.span,
            previousSpan: importNameCollision.span,
            ctx,
          });
          return undefined;
        }
        ctx.symbolTable.bindAlias(
          { name: importedName, symbol },
          ctx.symbolTable.rootScope,
        );
      }
      return {
        name: importedName,
        local: symbol,
        visibility: decl.visibility,
        span: entry.span,
      };
    }

    const importedTarget = importedSymbolTargetFromMetadata(
      record.metadata as Record<string, unknown> | undefined,
    );
    if (!importedTarget) {
      return undefined;
    }
    const existing = ctx.imports.find(
      (candidate) =>
        candidate.name === importedName &&
        candidate.target?.moduleId === importedTarget.moduleId &&
        candidate.target.symbol === importedTarget.symbol &&
        ctx.symbolTable.getSymbol(candidate.local).scope ===
          ctx.symbolTable.rootScope,
    );
    if (existing) {
      return {
        ...existing,
        visibility: decl.visibility,
        span: entry.span,
      };
    }

    const exported = Array.from(
      ctx.moduleExports.get(importedTarget.moduleId)?.values() ?? [],
    ).find(
      (candidate) =>
        candidate.symbol === importedTarget.symbol ||
        candidate.symbols?.includes(importedTarget.symbol),
    );
    const explicitlyTargetsStdSubmodule =
      importedModuleExplicitStdSubmoduleFrom(
        record.metadata as Record<string, unknown> | undefined,
      ) ?? false;
    if (
      !exported ||
      !canAccessExport({
        exported,
        moduleId: importedTarget.moduleId,
        ctx,
        explicitlyTargetsStdSubmodule,
      })
    ) {
      return undefined;
    }
    return declareImportedSymbol({
      exported,
      alias: importedName,
      explicitlyTargetsStdSubmodule,
      ctx,
      declaredAt: decl.form,
      span: entry.span,
      visibility: decl.visibility,
    })[0];
  };

  const imports = (() => {
    if (entry.selectionKind === "all") {
      return Array.from(
        new Set(namespaceMembers.map(({ name }) => name)),
      ).flatMap((name) => {
        const imported = localVariant(name);
        return imported ? [imported] : [];
      });
    }

    const targetName = entry.targetName ?? entry.alias;
    if (!targetName) {
      return [];
    }
    const imported = localVariant(targetName);
    return imported ? [imported] : [];
  })();

  if (imports.length === 0) {
    if (ambiguityReported) {
      return {
        path: entry.path,
        moduleId: ctx.module.id,
        span: entry.span,
        selectionKind: entry.selectionKind,
        targetName: entry.targetName,
        alias: entry.alias,
        imports: [],
      };
    }
    return undefined;
  }

  return {
    path: entry.path,
    moduleId: ctx.module.id,
    span: entry.span,
    selectionKind: entry.selectionKind,
    targetName: entry.targetName,
    alias: entry.alias,
    imports,
  };
};

const collectLocalTypeNamespaceMembers = ({
  namespaceSymbol,
  ctx,
  seen = new Set<SymbolId>(),
}: {
  namespaceSymbol: SymbolId;
  ctx: Pick<
    BindingContext,
    "decls" | "symbolTable" | "moduleMembers" | "staticMethods"
  >;
  seen?: Set<SymbolId>;
}): { name: string; symbol: SymbolId }[] => {
  if (seen.has(namespaceSymbol)) {
    return [];
  }
  const nextSeen = new Set(seen);
  nextSeen.add(namespaceSymbol);

  const aliasDecl = ctx.decls.getTypeAlias(namespaceSymbol);
  const targets = aliasDecl
    ? enumVariantTypeTargetsFromAliasTarget(aliasDecl.target)
    : undefined;
  if (targets) {
    return targets.flatMap((target) => {
      const symbol = resolveNominalTypeSymbol({
        target: target.target,
        scope: ctx.symbolTable.rootScope,
        symbolTable: ctx.symbolTable,
        moduleMembers: ctx.moduleMembers,
      });
      if (typeof symbol !== "number") {
        return [];
      }
      const record = ctx.symbolTable.getSymbol(symbol);
      const entity = (record.metadata as { entity?: unknown } | undefined)
        ?.entity;
      if (record.kind !== "type") {
        return [];
      }
      if (entity === "object") {
        return [{ name: target.name, symbol }];
      }
      if (entity === "type-alias") {
        return collectLocalTypeNamespaceMembers({
          namespaceSymbol: symbol,
          ctx,
          seen: nextSeen,
        });
      }
      return [];
    });
  }

  const methods = ctx.staticMethods.get(namespaceSymbol);
  if (!methods) {
    return [];
  }
  return Array.from(methods.entries()).flatMap(([name, symbols]) =>
    Array.from(symbols).flatMap((symbol) => {
      const record = ctx.symbolTable.getSymbol(symbol);
      const entity = (record.metadata as { entity?: unknown } | undefined)
        ?.entity;
      return record.kind === "type" && entity === "object"
        ? [{ name, symbol }]
        : [];
    }),
  );
};

const canonicalBindingSymbolKey = ({
  moduleId,
  symbol,
  binding,
}: {
  moduleId: string;
  symbol: SymbolId;
  binding: Pick<BindingContext, "symbolTable" | "dependencies">;
}): string => {
  const canonical = canonicalBindingSymbol({ moduleId, symbol, binding });
  return `${canonical.moduleId}:${canonical.symbol}`;
};

const canonicalBindingSymbol = ({
  moduleId,
  symbol,
  binding,
}: {
  moduleId: string;
  symbol: SymbolId;
  binding: Pick<BindingContext, "symbolTable" | "dependencies">;
}): {
  moduleId: string;
  symbol: SymbolId;
  binding: Pick<BindingContext, "symbolTable" | "dependencies">;
} => {
  let currentModuleId = moduleId;
  let currentSymbol = symbol;
  let current = binding;
  const visited = new Set<string>();

  while (true) {
    const key = `${currentModuleId}:${currentSymbol}`;
    if (visited.has(key)) {
      return {
        moduleId: currentModuleId,
        symbol: currentSymbol,
        binding: current,
      };
    }
    visited.add(key);
    const imported = importedSymbolTargetFromMetadata(
      current.symbolTable.getSymbol(currentSymbol).metadata,
    );
    if (!imported) {
      return {
        moduleId: currentModuleId,
        symbol: currentSymbol,
        binding: current,
      };
    }
    const dependency = current.dependencies.get(imported.moduleId);
    if (!dependency) {
      return {
        moduleId: imported.moduleId,
        symbol: imported.symbol,
        binding: current,
      };
    }
    currentModuleId = imported.moduleId;
    currentSymbol = imported.symbol;
    current = dependency;
  }
};

const isStdImportBlocked = ({
  dependencyPath,
  entry,
  ctx,
}: {
  dependencyPath: ModulePath;
  entry: ParsedUseEntry;
  ctx: BindingContext;
}): boolean => {
  if (dependencyPath.namespace !== "std") {
    return false;
  }
  if (ctx.module.path.namespace === "std") {
    return false;
  }
  if (
    dependencyPath.segments.length === 1 &&
    dependencyPath.segments[0] === "pkg"
  ) {
    return false;
  }
  const explicitlyTargetsSubmodule = isExplicitStdSubmoduleEntry(entry);
  if (explicitlyTargetsSubmodule) {
    return false;
  }
  const moduleId = modulePathToString(dependencyPath);
  return !stdPkgExportsFor({ moduleId, ctx });
};

const isExplicitStdSubmoduleEntry = (entry: ParsedUseEntry): boolean =>
  entry.moduleSegments[0] === "std" && entry.moduleSegments.length > 1;

const isStdSubmoduleModuleId = (moduleId: string): boolean =>
  moduleId.startsWith("std::") && moduleId !== "std::pkg";

const inlineModuleNamesFor = (ctx: BindingContext): Set<string> =>
  new Set(
    requireModuleSurface(ctx.module).items.flatMap((item) =>
      item.kind === "inline-module" ? [item.declaration.name] : [],
    ),
  );

const shouldPreserveInlinePkgScope = ({
  entry,
  ctx,
}: {
  entry: ParsedUseEntry;
  ctx: BindingContext;
}): boolean => {
  if (!ctx.isPackageRoot) {
    return false;
  }
  if (entry.anchorToSelf !== true || (entry.parentHops ?? 0) !== 0) {
    return false;
  }
  const firstSegment = entry.moduleSegments[0];
  return (
    typeof firstSegment === "string" &&
    inlineModuleNamesFor(ctx).has(firstSegment)
  );
};

const shouldAllowImplicitPackageRootAlias = ({
  dependencyPath,
  ctx,
}: {
  dependencyPath: ModulePath;
  ctx: BindingContext;
}): boolean => {
  if (dependencyPath.segments.at(-1) !== "pkg") {
    return false;
  }
  const dependency = ctx.graph.modules.get(modulePathToString(dependencyPath));
  if (!dependency) {
    return false;
  }

  return isPackageRootModule(dependency.path, {
    sourcePackageRoot: dependency.sourcePackageRoot,
  });
};

const resolveDependencyPath = ({
  entry,
  ctx,
}: {
  entry: ParsedUseEntry;
  ctx: BindingContext;
}): ModulePath | undefined => {
  const preservesInlinePkgScope = shouldPreserveInlinePkgScope({ entry, ctx });
  const matchingDependencies = ctx.module.dependencies.flatMap((dep) => {
    const allowImplicitPackageRootAlias = shouldAllowImplicitPackageRootAlias({
      dependencyPath: dep.path,
      ctx,
    });
    const sharedOptions = {
      dependencyPath: dep.path,
      entry,
      currentModulePath: ctx.module.path,
      currentModuleIsPackageRoot: ctx.isPackageRoot && !preservesInlinePkgScope,
    };
    const matchesWithAlias = matchesDependencyPath({
      ...sharedOptions,
      allowImplicitPackageRootAlias,
    });
    if (!matchesWithAlias) {
      return [];
    }
    const matchesWithoutAlias = matchesDependencyPath({
      ...sharedOptions,
      allowImplicitPackageRootAlias: false,
    });
    return [{ dependency: dep, matchesWithoutAlias }];
  });

  const strictMatches = matchingDependencies
    .filter((candidate) => candidate.matchesWithoutAlias)
    .map((candidate) => candidate.dependency);
  const matches =
    strictMatches.length > 0
      ? strictMatches
      : matchingDependencies.map((candidate) => candidate.dependency);
  if (matches.length === 0) {
    return undefined;
  }

  const firstSegment = entry.moduleSegments.at(0);
  const isExplicitlyNamespaced =
    firstSegment === "src" || firstSegment === "std" || firstSegment === "pkg";

  if (isExplicitlyNamespaced) {
    const preferred = matches.find((dep) => dep.kind === "use") ?? matches[0];
    return preferred?.path;
  }

  const longest = matches.reduce<(typeof matches)[number] | undefined>(
    (best, dep) => {
      if (!best) return dep;
      if (dep.path.segments.length !== best.path.segments.length) {
        return dep.path.segments.length > best.path.segments.length
          ? dep
          : best;
      }
      if (dep.kind !== best.kind) {
        return dep.kind === "export" ? dep : best;
      }
      return best;
    },
    undefined,
  );

  return longest?.path;
};

const bindImportsFromModule = ({
  moduleId,
  entry,
  explicitlyTargetsStdSubmodule: explicitStdSubmoduleOverride,
  ctx,
  declaredAt,
  visibility,
}: {
  moduleId: string;
  entry: ParsedUseEntry;
  explicitlyTargetsStdSubmodule?: boolean;
  ctx: BindingContext;
  declaredAt: Form;
  visibility: HirVisibility;
}): BoundImport[] => {
  let exports = ctx.moduleExports.get(moduleId);
  let exportSurface = ctx.moduleExportSurfaces.get(moduleId);
  const explicitlyTargetsStdSubmodule =
    explicitStdSubmoduleOverride ?? isExplicitStdSubmoduleEntry(entry);
  const isStdImport =
    isStdSubmoduleModuleId(moduleId) && ctx.module.path.namespace !== "std";
  const stdPkgExports =
    isStdImport && !explicitlyTargetsStdSubmodule
      ? stdPkgExportsFor({ moduleId, ctx })
      : undefined;
  if (isStdImport && !explicitlyTargetsStdSubmodule) {
    exports = stdPkgExports;
    exportSurface = undefined;
  }

  if (exports) {
    return bindImportsFromExportTable({
      moduleId,
      entry,
      exports,
      explicitlyTargetsStdSubmodule,
      ctx,
      declaredAt,
      visibility,
    });
  }

  if (exportSurface) {
    return bindImportsFromExportSurface({
      moduleId,
      entry,
      exportSurface,
      explicitlyTargetsStdSubmodule,
      ctx,
      declaredAt,
      visibility,
    });
  }

  recordImportDiagnostic({
    params: { kind: "module-unavailable", moduleId },
    span: entry.span,
    ctx,
  });
  return [];
};

const bindImportsFromExportTable = ({
  moduleId,
  entry,
  exports,
  explicitlyTargetsStdSubmodule,
  ctx,
  declaredAt,
  visibility,
}: {
  moduleId: string;
  entry: ParsedUseEntry;
  exports: Map<string, ModuleExportEntry>;
  explicitlyTargetsStdSubmodule: boolean;
  ctx: BindingContext;
  declaredAt: Form;
  visibility: HirVisibility;
}): BoundImport[] => {
  const ownerNameFor = (exported: ModuleExportEntry): string | undefined => {
    const owner = firstInstanceMemberOwner(exported);
    if (typeof owner !== "number") {
      return undefined;
    }
    const dependency = ctx.dependencies.get(moduleId);
    if (!dependency) {
      return undefined;
    }
    try {
      return dependency.symbolTable.getSymbol(owner).name;
    } catch {
      return undefined;
    }
  };

  const includeInWildcardImport = (
    exported: Pick<ModuleExportEntry, "kind">,
  ): boolean => exported.kind !== "effect-op";

  if (entry.selectionKind === "all") {
    const allowed = Array.from(exports.values()).flatMap((item) => {
      if (!includeInWildcardImport(item)) {
        return [];
      }
      const accessible = canAccessExport({
        exported: item,
        moduleId,
        ctx,
        explicitlyTargetsStdSubmodule,
      });
      if (!accessible) {
        return [];
      }
      const moduleExport = moduleNamespaceExportEntry(item);
      return moduleExport ? [moduleExport] : [];
    });
    return allowed.flatMap((item) =>
      declareImportedSymbol({
        exported: item,
        alias: item.name,
        explicitlyTargetsStdSubmodule,
        ctx,
        declaredAt,
        span: entry.span,
        visibility,
      }),
    );
  }

  const targetName = entry.targetName ?? entry.alias;
  if (!targetName) {
    recordImportDiagnostic({
      params: { kind: "missing-target" },
      span: entry.span,
      ctx,
    });
    return [];
  }

  const exported = exports.get(targetName);
  if (!exported) {
    if (isMacroExportedFromModule({ moduleId, targetName, ctx })) {
      recordMacroBoundaryDiagnostic({
        moduleId,
        targetName,
        span: entry.span,
        ctx,
      });
      return [];
    }
    recordUnavailableExportDiagnostic({
      moduleId,
      targetName,
      span: entry.span,
      ctx,
    });
    return [];
  }
  if (isImplicitEffectOperationExport({ exported, ctx })) {
    recordImportDiagnostic({
      params: { kind: "missing-export", moduleId, target: targetName },
      span: entry.span,
      ctx,
    });
    return [];
  }

  const moduleExport = moduleNamespaceExportEntry(exported);
  if (!moduleExport) {
    recordImportDiagnostic({
      params: {
        kind: "instance-member-import",
        moduleId,
        target: targetName,
        owner: ownerNameFor(exported),
      },
      span: entry.span,
      ctx,
    });
    return [];
  }

  if (
    !canAccessExport({
      exported,
      moduleId,
      ctx,
      explicitlyTargetsStdSubmodule,
    })
  ) {
    recordOutOfScopeExportDiagnostic({
      exported,
      moduleId,
      targetName,
      span: entry.span,
      ctx,
    });
    return [];
  }

  return declareImportedSymbol({
    exported: moduleExport,
    alias: entry.alias ?? targetName,
    explicitlyTargetsStdSubmodule,
    ctx,
    declaredAt,
    span: entry.span,
    visibility,
  });
};

const isImplicitEffectOperationExport = ({
  exported,
  ctx,
}: {
  exported: ModuleExportEntry;
  ctx: BindingContext;
}): boolean =>
  exported.kind === "effect-op" &&
  ctx.dependencies
    .get(exported.moduleId)
    ?.decls.getEffectOperation(exported.symbol) !== undefined;

const bindImportsFromExportSurface = ({
  moduleId,
  entry,
  exportSurface,
  explicitlyTargetsStdSubmodule,
  ctx,
  declaredAt,
  visibility,
}: {
  moduleId: string;
  entry: ParsedUseEntry;
  exportSurface: Map<string, ModuleExportSurfaceEntry>;
  explicitlyTargetsStdSubmodule: boolean;
  ctx: BindingContext;
  declaredAt: Form;
  visibility: HirVisibility;
}): BoundImport[] => {
  const isAccessible = (exported: ModuleExportSurfaceEntry): boolean =>
    canAccessSymbolVisibility({
      visibility: exported.visibility,
      ownerPackageId: exported.packageId,
      importedFromModuleId: moduleId,
      explicitlyTargetsStdSubmodule,
      ctx,
    });

  const includeInWildcardImport = (
    exported: Pick<ModuleExportSurfaceEntry, "kind">,
  ): boolean => exported.kind !== "effect-op";

  if (entry.selectionKind === "all") {
    return Array.from(exportSurface.values())
      .filter((item) => includeInWildcardImport(item))
      .filter((item) => isAccessible(item))
      .flatMap((item) =>
        declareSurfaceImportedSymbol({
          exported: item,
          alias: item.name,
          explicitlyTargetsStdSubmodule,
          ctx,
          declaredAt,
          span: entry.span,
          visibility,
        }),
      );
  }

  const targetName = entry.targetName ?? entry.alias;
  if (!targetName) {
    recordImportDiagnostic({
      params: { kind: "missing-target" },
      span: entry.span,
      ctx,
    });
    return [];
  }

  const exported = exportSurface.get(targetName);
  if (!exported) {
    if (isMacroExportedFromModule({ moduleId, targetName, ctx })) {
      recordMacroBoundaryDiagnostic({
        moduleId,
        targetName,
        span: entry.span,
        ctx,
      });
      return [];
    }
    recordUnavailableExportDiagnostic({
      moduleId,
      targetName,
      span: entry.span,
      ctx,
    });
    return [];
  }
  if (exported.kind === "effect-op") {
    recordImportDiagnostic({
      params: { kind: "missing-export", moduleId, target: targetName },
      span: entry.span,
      ctx,
    });
    return [];
  }

  if (!isAccessible(exported)) {
    recordOutOfScopeExportDiagnostic({
      exported,
      moduleId,
      targetName,
      span: entry.span,
      ctx,
    });
    return [];
  }

  return declareSurfaceImportedSymbol({
    exported,
    alias: entry.alias ?? targetName,
    explicitlyTargetsStdSubmodule,
    ctx,
    declaredAt,
    span: entry.span,
    visibility,
  });
};

const isMacroExportedFromModule = ({
  moduleId,
  targetName,
  ctx,
}: {
  moduleId: string;
  targetName: string;
  ctx: BindingContext;
}): boolean =>
  Boolean(ctx.graph.modules.get(moduleId)?.macroExports?.includes(targetName));

const recordUnavailableExportDiagnostic = ({
  moduleId,
  targetName,
  span,
  ctx,
}: {
  moduleId: string;
  targetName: string;
  span: SourceSpan;
  ctx: BindingContext;
}): void => {
  const module = ctx.graph.modules.get(moduleId);
  const declarationFile = moduleFilePath(module);
  const packageRoot = packageRootReferenceFor({ moduleId, ctx });
  const crossesPackageBoundary =
    module !== undefined &&
    modulePackageId(module) !== ctx.packageId &&
    !isPackageRootModule(module.path, {
      sourcePackageRoot: module.sourcePackageRoot,
    }) &&
    packageRoot !== undefined;
  const macro = module
    ? requireModuleHeader(module).items.find(
        (item) =>
          item.kind === "macro" && item.declaration.name === targetName,
      )
    : undefined;
  if (macro && declarationFile) {
    recordImportDiagnostic({
      params: {
        kind: "macro-not-exported",
        moduleId,
        target: targetName,
        declarationFile,
        ...(crossesPackageBoundary && packageRoot
          ? {
              packageRootFile: packageRoot.file,
              packageRootPath: packageRoot.path,
            }
          : {}),
      },
      span,
      ctx,
    });
    return;
  }

  const dependency = ctx.dependencies.get(moduleId);
  const visibility = dependency
    ? topLevelDeclarationVisibility({ targetName, dependency })
    : undefined;
  if (crossesPackageBoundary && packageRoot && visibility) {
    recordImportDiagnostic({
      params: {
        kind: "hidden-package-internal",
        moduleId,
        target: targetName,
        visibility: visibility.level,
        packageRootFile: packageRoot.file,
        packageRootPath: packageRoot.path,
      },
      span,
      ctx,
    });
    return;
  }
  if (visibility?.level === "module" && declarationFile) {
    recordImportDiagnostic({
      params: {
        kind: "module-private-access",
        moduleId,
        target: targetName,
        declarationFile,
      },
      span,
      ctx,
    });
    return;
  }

  if (
    module &&
    packageRoot &&
    isPackageRootModule(module.path, {
      sourcePackageRoot: module.sourcePackageRoot,
    })
  ) {
    recordImportDiagnostic({
      params: {
        kind: "missing-export",
        moduleId: packageRoot.path,
        target: targetName,
        packageRootFile: packageRoot.file,
      },
      span,
      ctx,
    });
    return;
  }

  recordImportDiagnostic({
    params: { kind: "missing-export", moduleId, target: targetName },
    span,
    ctx,
  });
};

const topLevelDeclarationVisibility = ({
  targetName,
  dependency,
}: {
  targetName: string;
  dependency: BindingResult;
}): HirVisibility | undefined => {
  const declarations = [
    ...dependency.decls.functions.filter((decl) => decl.implId === undefined),
    ...dependency.decls.moduleLets,
    ...dependency.decls.typeAliases,
    ...dependency.decls.objects,
    ...dependency.decls.traits,
    ...dependency.decls.effects,
  ];
  return declarations.find((decl) => decl.name === targetName)?.visibility;
};

const recordMacroBoundaryDiagnostic = ({
  moduleId,
  targetName,
  span,
  ctx,
}: {
  moduleId: string;
  targetName: string;
  span: SourceSpan;
  ctx: BindingContext;
}): void => {
  const module = ctx.graph.modules.get(moduleId);
  if (
    !module ||
    module.path.namespace === "std" ||
    modulePackageId(module) === ctx.packageId ||
    isPackageRootModule(module.path, {
      sourcePackageRoot: module.sourcePackageRoot,
    })
  ) {
    return;
  }
  const packageRoot = packageRootReferenceFor({ moduleId, ctx });
  if (!packageRoot) {
    return;
  }
  recordImportDiagnostic({
    params: {
      kind: "hidden-package-internal",
      moduleId,
      target: targetName,
      visibility: "package",
      packageRootFile: packageRoot.file,
      packageRootPath: packageRoot.path,
    },
    span,
    ctx,
  });
};

const recordOutOfScopeExportDiagnostic = ({
  exported,
  moduleId,
  targetName,
  span,
  ctx,
}: {
  exported: Pick<ModuleExportEntry, "visibility" | "packageId">;
  moduleId: string;
  targetName: string;
  span: SourceSpan;
  ctx: BindingContext;
}): void => {
  const module = ctx.graph.modules.get(moduleId);
  const packageRoot = packageRootReferenceFor({ moduleId, ctx });
  if (
    module &&
    exported.packageId !== ctx.packageId &&
    !isPackageRootModule(module.path, {
      sourcePackageRoot: module.sourcePackageRoot,
    }) &&
    packageRoot
  ) {
    recordImportDiagnostic({
      params: {
        kind: "hidden-package-internal",
        moduleId,
        target: targetName,
        visibility: exported.visibility.level,
        packageRootFile: packageRoot.file,
        packageRootPath: packageRoot.path,
      },
      span,
      ctx,
    });
    return;
  }

  if (exported.packageId !== ctx.packageId) {
    recordImportDiagnostic({
      params: {
        kind: "package-private-access",
        moduleId,
        target: targetName,
        visibility: exported.visibility.level,
        ownerPackage: exported.packageId,
        consumerPackage: ctx.packageId,
        packageRootFile: packageRoot?.file,
        packageRootPath: packageRoot?.path,
      },
      span,
      ctx,
    });
    return;
  }

  recordImportDiagnostic({
    params: {
      kind: "out-of-scope-export",
      moduleId,
      target: targetName,
      visibility: exported.visibility.level,
    },
    span,
    ctx,
  });
};

const moduleFilePath = (module: ModuleNode | undefined): string | undefined =>
  module?.origin.kind === "file"
    ? module.origin.filePath
    : module?.origin.span?.file;

const modulePackageId = (module: ModuleNode): string => {
  if (module.path.namespace === "std") {
    return "std";
  }
  if (module.path.namespace === "pkg") {
    return `pkg:${module.path.packageName ?? "unknown"}`;
  }
  return module.sourcePackageRoot && module.sourcePackageRoot.length > 0
    ? `local:${module.sourcePackageRoot.join("::")}`
    : "local";
};

type PackageRootReference = {
  file: string;
  path: string;
};

const packageRootReferenceFor = ({
  moduleId,
  ctx,
}: {
  moduleId: string;
  ctx: BindingContext;
}): PackageRootReference | undefined => {
  const module = ctx.graph.modules.get(moduleId);
  if (!module) {
    return undefined;
  }
  const packageId = modulePackageId(module);
  const loadedRoot = Array.from(ctx.graph.modules.values())
    .filter(
      (candidate) =>
        modulePackageId(candidate) === packageId &&
        isPackageRootModule(candidate.path, {
          sourcePackageRoot: candidate.sourcePackageRoot,
        }) &&
        packageRootContainsModule({ packageRoot: candidate, module }),
    )
    .sort(
      (left, right) =>
        right.path.segments.length - left.path.segments.length,
    )[0];
  const file = moduleFilePath(loadedRoot) ?? inferredPackageRootFile(module);
  const path = loadedRoot
    ? logicalPackageRootPath(loadedRoot.path)
    : inferredPackageRootPath(module);
  return file && path ? { file, path } : undefined;
};

const packageRootContainsModule = ({
  packageRoot,
  module,
}: {
  packageRoot: ModuleNode;
  module: ModuleNode;
}): boolean => {
  if (
    packageRoot.path.namespace !== module.path.namespace ||
    packageRoot.path.packageName !== module.path.packageName
  ) {
    return false;
  }
  const rootSegments = packageRoot.path.segments.slice(0, -1);
  return rootSegments.every(
    (segment, index) => module.path.segments[index] === segment,
  );
};

const logicalPackageRootPath = (path: ModulePath): string => {
  const segments = path.segments.slice(0, -1);
  if (path.namespace === "pkg") {
    return ["pkg", path.packageName, ...segments].filter(Boolean).join("::");
  }
  return [path.namespace, ...segments].join("::");
};

const inferredPackageRootPath = (module: ModuleNode): string | undefined => {
  if (module.path.namespace === "pkg") {
    return module.path.packageName
      ? `pkg::${module.path.packageName}`
      : undefined;
  }
  if (module.path.namespace === "std") {
    return "std";
  }
  return module.sourcePackageRoot && module.sourcePackageRoot.length > 0
    ? `src::${module.sourcePackageRoot.join("::")}`
    : "src";
};

const inferredPackageRootFile = (module: ModuleNode): string | undefined => {
  const filePath = moduleFilePath(module);
  if (!filePath) {
    return undefined;
  }
  const separator = filePath.includes("\\") ? "\\" : "/";
  const rootSegmentCount = module.sourcePackageRoot?.length ?? 0;
  const moduleDepth = Math.max(
    1,
    module.path.segments.length - rootSegmentCount,
  );
  let directory = filePath.slice(0, filePath.lastIndexOf(separator));
  for (let level = 1; level < moduleDepth; level += 1) {
    directory = directory.slice(0, directory.lastIndexOf(separator));
  }
  return `${directory}${separator}pkg.voyd`;
};

const declareImportedSymbol = ({
  exported,
  alias,
  explicitlyTargetsStdSubmodule = false,
  effectName,
  ctx,
  declaredAt,
  span,
  visibility,
}: {
  exported: ModuleExportEntry;
  alias: string;
  explicitlyTargetsStdSubmodule?: boolean;
  effectName?: string;
  ctx: BindingContext;
  declaredAt: Form;
  span: SourceSpan;
  visibility: HirVisibility;
}): BoundImport[] => {
  const exportedSymbols =
    exported.symbols && exported.symbols.length > 0
      ? exported.symbols
      : [exported.symbol];
  const dependency = ctx.dependencies.get(exported.moduleId);
  const symbols = dependency
    ? exportedSymbols.filter(
        (symbol) =>
          dependency.symbolTable.getSymbol(symbol).kind === exported.kind,
      )
    : exportedSymbols;
  const locals: BoundImport[] = [];

  const effectOperationConflict = findEffectOperationSelectionConflict({
    name: alias,
    incomingKind: exported.kind,
    incomingModuleId: exported.moduleId,
    incomingSymbols: symbols,
    fallbackSpan: span,
    ctx,
  });
  if (effectOperationConflict) {
    recordImportNameConflict({
      name: alias,
      incomingKind: exported.kind,
      existingKind: effectOperationConflict.kind,
      effectName: effectName ?? effectOperationConflict.effectName,
      span,
      previousSpan: effectOperationConflict.span,
      ctx,
    });
    return [];
  }

  symbols.forEach((symbol) => {
    const importNameCollision = findModuleNamespaceNameCollision({
      name: alias,
      scope: ctx.symbolTable.rootScope,
      incomingKind: exported.kind,
      ctx,
    });
    if (importNameCollision) {
      recordImportNameConflict({
        name: alias,
        incomingKind: exported.kind,
        existingKind: importNameCollision.kind,
        effectName,
        span,
        previousSpan: importNameCollision.span,
        ctx,
      });
      return;
    }

    const sourceMetadata = dependency
      ? dependency.symbolTable.getSymbol(symbol).metadata
      : undefined;
    const importableMetadata = importableMetadataFrom(
      sourceMetadata as Record<string, unknown> | undefined,
    );
    const importedSymbolTarget =
      exported.kind !== "module"
        ? importedSymbolTargetFromMetadata(
            sourceMetadata as Record<string, unknown> | undefined,
          )
        : undefined;
    const importedModuleId =
      exported.kind === "module"
        ? (importedModuleIdFrom(
            sourceMetadata as Record<string, unknown> | undefined,
          ) ?? exported.moduleId)
        : (importedSymbolTarget?.moduleId ?? exported.moduleId);
    const importedModuleExplicitStdSubmodule =
      importedModuleExplicitStdSubmoduleFrom(
        sourceMetadata as Record<string, unknown> | undefined,
      ) ?? explicitlyTargetsStdSubmodule;
    const importedSymbolId =
      exported.kind !== "module"
        ? (importedSymbolTarget?.symbol ?? symbol)
        : undefined;
    const local = ctx.symbolTable.declare({
      name: alias,
      kind: exported.kind,
      declaredAt: declaredAt.syntaxId,
      metadata: {
        import:
          exported.kind === "module"
            ? {
                moduleId: importedModuleId,
                explicitlyTargetsStdSubmodule:
                  importedModuleExplicitStdSubmodule,
              }
            : {
                moduleId: importedModuleId,
                symbol: importedSymbolId,
                explicitlyTargetsStdSubmodule:
                  importedModuleExplicitStdSubmodule,
              },
        ...(importableMetadata ?? {}),
      },
    });
    const bound: BoundImport = {
      name: alias,
      local,
      target:
        exported.kind === "module"
          ? undefined
          : {
              moduleId: importedModuleId,
              symbol: importedSymbolId as SymbolId,
            },
      visibility,
      span,
    };
    ctx.imports.push(bound);
    hydrateImportedEnumAliasNamespace({
      namespaceSymbol: local,
      importedModuleId,
      explicitlyTargetsStdSubmodule: importedModuleExplicitStdSubmodule,
      importedSymbolId:
        typeof importedSymbolId === "number" ? importedSymbolId : undefined,
      declaredAt,
      ctx,
    });
    locals.push(bound);
  });

  if (locals.length === 0) {
    return locals;
  }

  if (symbols.length > 1 && exported.overloadSet !== undefined) {
    const nextId = Math.max(-1, ...ctx.importedOverloadOptions.keys()) + 1;
    const localSymbols = locals.map((entry) => entry.local);
    ctx.importedOverloadOptions.set(nextId, localSymbols);
    localSymbols.forEach((local) => ctx.overloadBySymbol.set(local, nextId));
  } else if (symbols.length === 1 && exported.overloadSet !== undefined) {
    ctx.overloadBySymbol.set(locals[0]!.local, exported.overloadSet);
  }

  return locals;
};

const declareSurfaceImportedSymbol = ({
  exported,
  alias,
  explicitlyTargetsStdSubmodule = false,
  ctx,
  declaredAt,
  span,
  visibility,
}: {
  exported: ModuleExportSurfaceEntry;
  alias: string;
  explicitlyTargetsStdSubmodule?: boolean;
  ctx: BindingContext;
  declaredAt: Form;
  span: SourceSpan;
  visibility: HirVisibility;
}): BoundImport[] => {
  const importNameCollision = findModuleNamespaceNameCollision({
    name: alias,
    scope: ctx.symbolTable.rootScope,
    incomingKind: exported.kind,
    ctx,
  });
  if (importNameCollision) {
    recordImportNameConflict({
      name: alias,
      incomingKind: exported.kind,
      existingKind: importNameCollision.kind,
      span,
      previousSpan: importNameCollision.span,
      ctx,
    });
    return [];
  }

  const local = ctx.symbolTable.declare({
    name: alias,
    kind: exported.kind,
    declaredAt: declaredAt.syntaxId,
    metadata: {
      import: {
        moduleId: exported.moduleId,
        explicitlyTargetsStdSubmodule,
      },
    },
  });
  const bound: BoundImport = {
    name: alias,
    local,
    visibility,
    span,
  };
  ctx.imports.push(bound);
  return [bound];
};

const hydrateImportedEnumAliasNamespace = ({
  namespaceSymbol,
  importedModuleId,
  explicitlyTargetsStdSubmodule = false,
  importedSymbolId,
  declaredAt,
  ctx,
}: {
  namespaceSymbol: SymbolId;
  importedModuleId: string;
  explicitlyTargetsStdSubmodule?: boolean;
  importedSymbolId?: SymbolId;
  declaredAt: Form;
  ctx: BindingContext;
}): void => {
  if (typeof importedSymbolId !== "number") {
    return;
  }

  const dependency = ctx.dependencies.get(importedModuleId);
  if (!dependency) {
    return;
  }

  const importedAliasMetadata = dependency.symbolTable.getSymbol(
    importedSymbolId,
  ).metadata;
  const declaredVariantNames = new Set(
    enumNamespaceMemberNamesFromMetadata(importedAliasMetadata) ?? [],
  );

  const variantMembers = collectLocalTypeNamespaceMembers({
    namespaceSymbol: importedSymbolId,
    ctx: dependency,
  });
  if (variantMembers.length === 0) {
    return;
  }

  const bucket = ctx.staticMethods.get(namespaceSymbol) ?? new Map();
  let changed = false;

  variantMembers.forEach(({ name: variantName, symbol: variantSymbol }) => {
    const canonical = canonicalBindingSymbol({
      moduleId: importedModuleId,
      symbol: variantSymbol,
      binding: dependency,
    });
    const exported = Array.from(
      ctx.moduleExports.get(canonical.moduleId)?.values() ?? [],
    ).find((entry) => entry.symbol === canonical.symbol);
    const exportedRecord = canonical.binding.symbolTable.getSymbol(
      canonical.symbol,
    );
    const metadata = exportedRecord.metadata as { entity?: string } | undefined;
    if (exportedRecord.kind !== "type" || metadata?.entity !== "object") {
      return;
    }
    const isPrivateFreshEnumVariant =
      exportedRecord.bindingIdentity?.startsWith("fresh:") === true &&
      declaredVariantNames.has(variantName);
    if (
      !isPrivateFreshEnumVariant &&
      (!exported ||
        !canAccessExport({
          exported,
          moduleId: canonical.moduleId,
          ctx,
          explicitlyTargetsStdSubmodule,
        }))
    ) {
      return;
    }

    const existing = ctx.imports.find(
      (entry) =>
        entry.target?.moduleId === canonical.moduleId &&
        entry.target.symbol === canonical.symbol,
    )?.local;
    const moduleNameFragment = canonical.moduleId.replace(
      /[^A-Za-z0-9_]/g,
      "_",
    );
    const hiddenImportName =
      `__enum_ns_${moduleNameFragment}_${canonical.symbol}_${exportedRecord.name}`;
    const hiddenBindingIdentity =
      `internal:enum-namespace-link:${JSON.stringify([
        canonical.moduleId,
        canonical.symbol,
      ])}`;
    const local =
      typeof existing === "number"
        ? existing
        : ctx.symbolTable.declare({
            name: hiddenImportName,
            kind: exportedRecord.kind,
            declaredAt: declaredAt.syntaxId,
            bindingIdentity: hiddenBindingIdentity,
            metadata: {
              import: {
                moduleId: canonical.moduleId,
                symbol: canonical.symbol,
                explicitlyTargetsStdSubmodule,
              },
              ...(importableMetadataFrom(
                exportedRecord.metadata as Record<string, unknown> | undefined,
              ) ?? {}),
              implicitCompilerImport: true,
            },
          });
    if (typeof existing !== "number") {
      ctx.imports.push({
        name: hiddenImportName,
        local,
        target: { moduleId: canonical.moduleId, symbol: canonical.symbol },
        visibility: moduleVisibility(),
        span: toSourceSpan(declaredAt),
      });
    }

    const variants = bucket.get(variantName) ?? new Set<SymbolId>();
    const sizeBefore = variants.size;
    variants.add(local);
    bucket.set(variantName, variants);
    changed ||= variants.size !== sizeBefore;
  });

  if (!changed) {
    return;
  }
  ctx.staticMethods.set(namespaceSymbol, bucket);
};

const declareModuleImport = ({
  moduleId,
  alias,
  explicitlyTargetsStdSubmodule = false,
  ctx,
  declaredAt,
  span,
  visibility,
}: {
  moduleId?: string;
  alias?: string;
  explicitlyTargetsStdSubmodule?: boolean;
  ctx: BindingContext;
  declaredAt: Form;
  span: SourceSpan;
  visibility: HirVisibility;
}): BoundImport[] => {
  if (!moduleId) {
    recordImportDiagnostic({
      params: { kind: "missing-module-identifier" },
      span,
      ctx,
    });
    return [];
  }
  const name = alias ?? moduleId.split("::").at(-1) ?? "self";
  const importNameCollision = findModuleNamespaceNameCollision({
    name,
    scope: ctx.symbolTable.rootScope,
    incomingKind: "module",
    ctx,
  });
  if (importNameCollision) {
    recordImportNameConflict({
      name,
      incomingKind: "module",
      existingKind: importNameCollision.kind,
      span,
      previousSpan: importNameCollision.span,
      ctx,
    });
    return [];
  }

  const local = ctx.symbolTable.declare({
    name,
    kind: "module",
    declaredAt: declaredAt.syntaxId,
    metadata: { import: { moduleId, explicitlyTargetsStdSubmodule } },
  });
  const bound: BoundImport = {
    name,
    local,
    target: undefined,
    visibility,
    span,
  };
  ctx.imports.push(bound);
  return [bound];
};

const recordImportDiagnostic = ({
  params,
  span,
  ctx,
}: {
  params: DiagnosticParams<"BD0001">;
  span: SourceSpan;
  ctx: BindingContext;
}): void => {
  pushUniqueImportDiagnostic({
    diagnostic: diagnosticFromCode({
      code: "BD0001",
      params,
      span,
    }),
    ctx,
  });
};

const recordImportNameConflict = ({
  name,
  incomingKind,
  existingKind,
  effectName,
  span,
  previousSpan,
  ctx,
}: {
  name: string;
  incomingKind: SymbolKind;
  existingKind: SymbolKind;
  effectName?: string;
  span: SourceSpan;
  previousSpan: SourceSpan;
  ctx: BindingContext;
}) => {
  pushUniqueImportDiagnostic({
    diagnostic: diagnosticFromCode({
      code: "BD0001",
      params: {
        kind: "import-name-conflict",
        name,
        incomingKind,
        existingKind,
        effectName,
      },
      span,
      related: [
        diagnosticFromCode({
          code: "BD0001",
          params: { kind: "previous-import-name-conflict" },
          severity: "note",
          span: previousSpan,
        }),
      ],
    }),
    ctx,
  });
};

const importDiagnosticKeys = new WeakMap<BindingContext, Set<string>>();

const relatedDiagnosticKey = (diagnostic: Diagnostic): string =>
  (diagnostic.related ?? [])
    .map(
      (related) =>
        `${related.code}|${related.severity}|${related.span.file}|${related.span.start}|${related.span.end}|${related.message}`,
    )
    .join(";");

const importDiagnosticKey = (diagnostic: Diagnostic): string =>
  [
    diagnostic.code,
    diagnostic.severity,
    diagnostic.phase ?? "",
    diagnostic.span.file,
    diagnostic.span.start,
    diagnostic.span.end,
    diagnostic.message,
    relatedDiagnosticKey(diagnostic),
  ].join("|");

const pushUniqueImportDiagnostic = ({
  diagnostic,
  ctx,
}: {
  diagnostic: Diagnostic;
  ctx: BindingContext;
}): void => {
  const key = importDiagnosticKey(diagnostic);
  const keys = importDiagnosticKeys.get(ctx) ?? new Set<string>();
  if (keys.has(key)) {
    return;
  }

  keys.add(key);
  importDiagnosticKeys.set(ctx, keys);
  ctx.diagnostics.push(diagnostic);
};
