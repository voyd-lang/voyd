import { type Form, isForm } from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import {
  parseFunctionDecl,
  parseObjectDecl,
  parseTypeAliasDecl,
  parseImplDecl,
  parseTraitDecl,
  parseEffectDecl,
} from "../parsing.js";
import { bindFunctionDecl } from "./function.js";
import { bindObjectDecl } from "./object.js";
import { bindTypeAlias, seedEnumAliasNamespaces } from "./type-alias.js";
import { bindTraitDecl } from "./trait.js";
import { bindImplDecl, flushPendingStaticMethods } from "./impl.js";
import { bindEffectDecl } from "./effect.js";
import type { BindingContext, BoundUseEntry, BoundImport } from "../types.js";
import {
  diagnosticFromCode,
  type DiagnosticParams,
} from "../../../diagnostics/index.js";
import { modulePathToString } from "../../../modules/path.js";
import type { ModulePath } from "../../../modules/types.js";
import {
  classifyTopLevelDecl,
  type TopLevelDeclClassification,
} from "../../../modules/use-decl.js";
import {
  parseUsePaths,
  type NormalizedUseEntry,
} from "../../../modules/use-path.js";
import { matchesDependencyPath } from "../../../modules/resolve.js";
import {
  type HirVisibility,
  isPackageVisible,
  moduleVisibility,
  packageVisibility,
} from "../../hir/index.js";
import type { SymbolKind } from "../../binder/index.js";
import type { ModuleExportEntry } from "../../modules.js";
import type { SourceSpan, SymbolId } from "../../ids.js";
import { BinderScopeTracker } from "./scope-tracker.js";
import {
  importableMetadataFrom,
  importedModuleIdFrom,
} from "../../imports/metadata.js";
import { findModuleNamespaceNameCollision } from "../name-collisions.js";
import {
  canAccessExport,
  stdPkgExportsFor,
} from "../export-visibility.js";
import {
  enumVariantTypeNamesFromAliasTarget,
  importedSymbolTargetFromMetadata,
} from "../../enum-namespace.js";

export const bindModule = (moduleForm: Form, ctx: BindingContext): void => {
  const tracker = new BinderScopeTracker(ctx.symbolTable);
  const entries = moduleForm.rest;

  for (const entry of entries) {
    if (!isForm(entry)) continue;
    if (!ctx.includeTests && isTestEntry(entry)) {
      continue;
    }
    const topLevelDecl = classifyTopLevelDecl(entry);
    const useDecl = parseUseDecl(entry, topLevelDecl);
    if (useDecl) {
      bindUseDecl(useDecl, ctx);
      continue;
    }

    if (topLevelDecl.kind === "macro-decl") {
      continue;
    }

    if (topLevelDecl.kind === "inline-module-decl") {
      continue;
    }

    if (topLevelDecl.kind === "unsupported-mod-decl") {
      ctx.diagnostics.push(
        diagnosticFromCode({
          code: "BD0005",
          params: { kind: "unsupported-mod-decl" },
          span: toSourceSpan(entry),
        }),
      );
      continue;
    }
    const parsed = parseFunctionDecl(entry);
    if (parsed) {
      bindFunctionDecl(parsed, ctx, tracker);
      continue;
    }

    const objectDecl = parseObjectDecl(entry);
    if (objectDecl) {
      bindObjectDecl(objectDecl, ctx, tracker);
      continue;
    }

    const typeDecl = parseTypeAliasDecl(entry);
    if (typeDecl) {
      bindTypeAlias(typeDecl, ctx, tracker);
      continue;
    }

    const traitDecl = parseTraitDecl(entry);
    if (traitDecl) {
      bindTraitDecl(traitDecl, ctx, tracker);
      continue;
    }

    const implDecl = parseImplDecl(entry);
    if (implDecl) {
      bindImplDecl(implDecl, ctx, tracker);
      continue;
    }

    const effectDecl = parseEffectDecl(entry);
    if (effectDecl) {
      bindEffectDecl(effectDecl, ctx, tracker);
      continue;
    }

    throw new Error(
      "unsupported top-level form; expected a function or type declaration",
    );
  }

  flushPendingStaticMethods(ctx);
  seedEnumAliasNamespaces(ctx);

  if (tracker.depth() !== 1) {
    throw new Error("binder scope stack imbalance after traversal");
  }
};

type ParsedUseEntry = NormalizedUseEntry;

type ParsedUseDecl = {
  form: Form;
  visibility: HirVisibility;
  entries: readonly ParsedUseEntry[];
};

const parseUseDecl = (
  form: Form,
  classified: TopLevelDeclClassification,
): ParsedUseDecl | null => {
  if (classified.kind !== "use-decl") {
    return null;
  }
  const visibility: HirVisibility =
    classified.visibility === "pub" ? packageVisibility() : moduleVisibility();
  const entries = parseUsePaths(classified.pathExpr, toSourceSpan(form));
  return { form, visibility, entries };
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
    const moduleId = importedModuleIdFrom(
      namespaceRecord.metadata as Record<string, unknown> | undefined,
    );
    if (!moduleId) {
      return undefined;
    }
    const imports =
      entry.selectionKind === "module"
        ? declareModuleImport({
            moduleId,
            alias: entry.alias ?? entry.path.at(-1),
            ctx,
            span: entry.span,
            declaredAt: decl.form,
            visibility: decl.visibility,
          })
        : bindImportsFromModule({
            moduleId,
            entry: { ...entry, hasExplicitPrefix: true },
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

  if (namespaceRecord.kind !== "type") {
    return undefined;
  }

  const importedTarget = importedSymbolTargetFromMetadata(
    namespaceRecord.metadata as Record<string, unknown> | undefined,
  );
  if (!importedTarget) {
    return undefined;
  }

  const dependency = ctx.dependencies.get(importedTarget.moduleId);
  const aliasDecl = dependency?.decls.getTypeAlias(importedTarget.symbol);
  const variantNames = aliasDecl
    ? enumVariantTypeNamesFromAliasTarget(aliasDecl.target)
    : undefined;
  if (!dependency || !variantNames || variantNames.length === 0) {
    return undefined;
  }

  const exports = ctx.moduleExports.get(importedTarget.moduleId);
  if (!exports) {
    return undefined;
  }

  const visibleObjectExportFor = (
    variantName: string,
  ): ModuleExportEntry | undefined => {
    if (!variantNames.includes(variantName)) {
      return undefined;
    }
    const exported = exports.get(variantName);
    if (!exported) {
      return undefined;
    }
    const exportedRecord = dependency.symbolTable.getSymbol(exported.symbol);
    const metadata = exportedRecord.metadata as { entity?: string } | undefined;
    if (exportedRecord.kind !== "type" || metadata?.entity !== "object") {
      return undefined;
    }
    if (!canAccessExport({ exported, moduleId: importedTarget.moduleId, ctx })) {
      return undefined;
    }
    return exported;
  };

  const imports = (() => {
    if (entry.selectionKind === "all") {
      return variantNames.flatMap((variantName) => {
        const exported = visibleObjectExportFor(variantName);
        if (!exported) {
          return [];
        }
        return declareImportedSymbol({
          exported,
          alias: variantName,
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
  const explicitlyTargetsSubmodule =
    entry.moduleSegments[0] === "std" && entry.moduleSegments.length > 1;
  if (explicitlyTargetsSubmodule) {
    return false;
  }
  const moduleId = modulePathToString(dependencyPath);
  return !stdPkgExportsFor({ moduleId, ctx });
};

const resolveDependencyPath = ({
  entry,
  ctx,
}: {
  entry: ParsedUseEntry;
  ctx: BindingContext;
}): ModulePath | undefined => {
  const matches = ctx.module.dependencies.filter((dep) =>
    matchesDependencyPath({
      dependencyPath: dep.path,
      entry,
      currentModulePath: ctx.module.path,
    }),
  );
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
  ctx,
  declaredAt,
  visibility,
}: {
  moduleId: string;
  entry: ParsedUseEntry;
  ctx: BindingContext;
  declaredAt: Form;
  visibility: HirVisibility;
}): BoundImport[] => {
  let exports = ctx.moduleExports.get(moduleId);
  const explicitlyTargetsStdSubmodule =
    entry.moduleSegments[0] === "std" && entry.moduleSegments.length > 1;
  const isStdImport =
    moduleId.startsWith("std::") &&
    moduleId !== "std::pkg" &&
    ctx.module.path.namespace !== "std";
  const stdPkgExports = isStdImport && !explicitlyTargetsStdSubmodule
    ? stdPkgExportsFor({ moduleId, ctx })
    : undefined;
  if (isStdImport && !explicitlyTargetsStdSubmodule && !stdPkgExports) {
    exports = undefined;
  }
  if (!exports) {
    recordImportDiagnostic({
      params: { kind: "module-unavailable", moduleId },
      span: entry.span,
      ctx,
    });
    return [];
  }

  const ownerNameFor = (exported: ModuleExportEntry): string | undefined => {
    if (typeof exported.memberOwner !== "number") {
      return undefined;
    }
    const dependency = ctx.dependencies.get(moduleId);
    if (!dependency) {
      return undefined;
    }
    try {
      return dependency.symbolTable.getSymbol(exported.memberOwner).name;
    } catch {
      return undefined;
    }
  };

  const isInstanceMemberExport = (exported: ModuleExportEntry): boolean =>
    typeof exported.memberOwner === "number" && exported.isStatic !== true;

  const allowMemberExport = (exported: ModuleExportEntry): boolean => {
    if (!isInstanceMemberExport(exported)) {
      return true;
    }
    if (isPackageVisible(visibility)) {
      return exported.apiProjection === true;
    }
    return true;
  };

  if (entry.selectionKind === "all") {
    const allowed = Array.from(exports.values()).filter((item) => {
      const accessible = canAccessExport({
        exported: item,
        moduleId,
        ctx,
        allowStdSubmodulePackageExports: explicitlyTargetsStdSubmodule,
      });
      if (!accessible) {
        return false;
      }
      if (!allowMemberExport(item)) {
        recordImportDiagnostic({
          params: {
            kind: "instance-member-import",
            moduleId,
            target: item.name,
            owner: ownerNameFor(item),
          },
          span: entry.span,
          ctx,
        });
        return false;
      }
      return true;
    });
    return allowed.flatMap((item) =>
      declareImportedSymbol({
        exported: item,
        alias: item.name,
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
      return [];
    }
    recordImportDiagnostic({
      params: { kind: "missing-export", moduleId, target: targetName },
      span: entry.span,
      ctx,
    });
    return [];
  }

  if (isInstanceMemberExport(exported)) {
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
      allowStdSubmodulePackageExports: explicitlyTargetsStdSubmodule,
    })
  ) {
    recordImportDiagnostic({
      params: {
        kind: "out-of-scope-export",
        moduleId,
        target: targetName,
        visibility: exported.visibility.level,
      },
      span: entry.span,
      ctx,
    });
    return [];
  }

  return declareImportedSymbol({
    exported,
    alias: entry.alias ?? targetName,
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

const declareImportedSymbol = ({
  exported,
  alias,
  ctx,
  declaredAt,
  span,
  visibility,
}: {
  exported: ModuleExportEntry;
  alias: string;
  ctx: BindingContext;
  declaredAt: Form;
  span: SourceSpan;
  visibility: HirVisibility;
}): BoundImport[] => {
  const symbols =
    exported.symbols && exported.symbols.length > 0
      ? exported.symbols
      : [exported.symbol];
  const locals: BoundImport[] = [];

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
        span,
        previousSpan: importNameCollision.span,
        ctx,
      });
      return;
    }

    const dependency = ctx.dependencies.get(exported.moduleId);
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
            ? { moduleId: importedModuleId }
            : { moduleId: importedModuleId, symbol: importedSymbolId },
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

const declareModuleImport = ({
  moduleId,
  alias,
  ctx,
  declaredAt,
  span,
  visibility,
}: {
  moduleId?: string;
  alias?: string;
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
    metadata: { import: { moduleId } },
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
  ctx.diagnostics.push(
    diagnosticFromCode({
      code: "BD0001",
      params,
      span,
    }),
  );
};

const recordImportNameConflict = ({
  name,
  incomingKind,
  existingKind,
  span,
  previousSpan,
  ctx,
}: {
  name: string;
  incomingKind: SymbolKind;
  existingKind: SymbolKind;
  span: SourceSpan;
  previousSpan: SourceSpan;
  ctx: BindingContext;
}) => {
  ctx.diagnostics.push(
    diagnosticFromCode({
      code: "BD0001",
      params: {
        kind: "import-name-conflict",
        name,
        incomingKind,
        existingKind,
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
  );
};
