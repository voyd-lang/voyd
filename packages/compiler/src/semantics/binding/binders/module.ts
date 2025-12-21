import {
  type Expr,
  type Form,
  type IdentifierAtom,
  isForm,
  isIdentifierAtom,
} from "../../../parser/index.js";
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
import { bindTypeAlias } from "./type-alias.js";
import {
  bindTraitDecl,
} from "./trait.js";
import { bindImplDecl, flushPendingStaticMethods } from "./impl.js";
import { bindEffectDecl } from "./effect.js";
import type {
  BindingContext,
  BoundUseEntry,
  BoundImport,
} from "../types.js";
import {
  diagnosticFromCode,
  type DiagnosticParams,
} from "../../../diagnostics/index.js";
import { modulePathToString } from "../../../modules/path.js";
import type { ModulePath } from "../../../modules/types.js";
import {
  parseUsePaths,
  type NormalizedUseEntry,
} from "../../../modules/use-path.js";
import {
  type HirVisibility,
  isPackageVisible,
  isPublicVisibility,
  moduleVisibility,
  packageVisibility,
} from "../../hir/index.js";
import type { ModuleExportEntry } from "../../modules.js";
import type { SourceSpan } from "../../ids.js";
import { BinderScopeTracker } from "./scope-tracker.js";
import { isSamePackage } from "../../packages.js";
import {
  importableMetadataFrom,
  importedModuleIdFrom,
} from "../../imports/metadata.js";

export const bindModule = (moduleForm: Form, ctx: BindingContext): void => {
  const tracker = new BinderScopeTracker(ctx.symbolTable);
  const entries = moduleForm.rest;

  for (const entry of entries) {
    if (!isForm(entry)) continue;
    const useDecl = parseUseDecl(entry);
    if (useDecl) {
      bindUseDecl(useDecl, ctx);
      continue;
    }

    if (isInlineModuleDecl(entry)) {
      continue;
    }

    const modDecl = parseModDecl(entry);
    if (modDecl) {
      bindUseDecl(modDecl, ctx);
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
      "unsupported top-level form; expected a function or type declaration"
    );
  }

  flushPendingStaticMethods(ctx);

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

const parseUseDecl = (form: Form): ParsedUseDecl | null => {
  let index = 0;
  let visibility: HirVisibility = moduleVisibility();
  const first = form.at(0);

  if (isIdentifierAtom(first) && first.value === "pub") {
    visibility = packageVisibility();
    index += 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierAtom(keyword) || keyword.value !== "use") {
    return null;
  }

  const pathExpr = form.at(index + 1);
  if (!pathExpr) {
    throw new Error("use statement missing a path");
  }

  const entries = parseUsePaths(pathExpr, toSourceSpan(form));
  return { form, visibility, entries };
};

const containsObjectLiteral = (expr?: Expr): boolean => {
  if (!isForm(expr)) return false;
  if (expr.callsInternal("object_literal") || expr.calls("object_literal")) {
    return true;
  }
  return expr.rest.some((child) => containsObjectLiteral(child));
};

const parseModDecl = (form: Form): ParsedUseDecl | null => {
  let index = 0;
  let visibility: HirVisibility = moduleVisibility();
  const first = form.at(0);

  if (isIdentifierAtom(first) && first.value === "pub") {
    visibility = packageVisibility();
    index += 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierAtom(keyword) || keyword.value !== "mod") {
    return null;
  }

  const pathExpr = form.at(index + 1);
  const maybeBody = form.at(index + 2);
  if (isForm(maybeBody) && maybeBody.calls("block")) {
    return null;
  }

  if (!pathExpr) {
    throw new Error("mod declaration missing a path");
  }

  const span = toSourceSpan(form);
  const isGrouped = containsObjectLiteral(pathExpr);
  const entries = parseUsePaths(pathExpr, span).map((entry) =>
    isGrouped
      ? entry
      : {
          ...entry,
          importKind: "all" as const,
          targetName: undefined,
        }
  );

  return { form, visibility, entries };
};

const isInlineModuleDecl = (form: Form): boolean => {
  const first = form.at(0);
  const isPub = isIdentifierAtom(first) && first.value === "pub";
  const offset = isPub ? 1 : 0;
  const keyword = form.at(offset);
  const nameExpr = form.at(offset + 1);
  const body = form.at(offset + 2);

  return (
    isIdentifierAtom(keyword) &&
    keyword.value === "mod" &&
    isIdentifierAtom(nameExpr) &&
    isForm(body) &&
    body.calls("block")
  );
};

const bindUseDecl = (decl: ParsedUseDecl, ctx: BindingContext): void => {
  const entries = decl.entries.map((entry) =>
    resolveUseEntry({ entry, decl, ctx })
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
  const dependencyPath = resolveDependencyPath({ entry, ctx });
  const moduleId = dependencyPath
    ? modulePathToString(dependencyPath)
    : undefined;
  if (!moduleId) {
    recordImportDiagnostic({
      params: { kind: "unresolved-use-path", path: entry.path },
      span: entry.span,
      ctx,
    });
  }

  const imports =
    entry.importKind === "self"
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
    importKind: entry.importKind,
    targetName: entry.targetName,
    alias: entry.alias,
    imports: imports ?? [],
  };
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
    })
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

  const longest = matches.reduce<(typeof matches)[number] | undefined>((best, dep) => {
    if (!best) return dep;
    if (dep.path.segments.length !== best.path.segments.length) {
      return dep.path.segments.length > best.path.segments.length ? dep : best;
    }
    if (dep.kind !== best.kind) {
      return dep.kind === "export" ? dep : best;
    }
    return best;
  }, undefined);

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
  const exports = ctx.moduleExports.get(moduleId);
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

  if (entry.importKind === "all") {
    const allowed = Array.from(exports.values()).filter((item) => {
      const accessible = canAccessExport({ exported: item, moduleId, ctx });
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
      })
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

  if (!canAccessExport({ exported, moduleId, ctx })) {
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
  const symbols = exported.symbols && exported.symbols.length > 0
    ? exported.symbols
    : [exported.symbol];
  const locals: BoundImport[] = [];

  symbols.forEach((symbol) => {
    const dependency = ctx.dependencies.get(exported.moduleId);
    const sourceMetadata = dependency
      ? dependency.symbolTable.getSymbol(symbol).metadata
      : undefined;
    const importableMetadata = importableMetadataFrom(
      sourceMetadata as Record<string, unknown> | undefined
    );
    const importedModuleId =
      exported.kind === "module"
        ? importedModuleIdFrom(sourceMetadata as Record<string, unknown> | undefined) ??
          exported.moduleId
        : exported.moduleId;
    const local = ctx.symbolTable.declare({
      name: alias,
      kind: exported.kind,
      declaredAt: declaredAt.syntaxId,
      metadata: {
        import:
          exported.kind === "module"
            ? { moduleId: importedModuleId }
            : { moduleId: exported.moduleId, symbol },
        ...(importableMetadata ?? {}),
      },
    });
    const bound: BoundImport = {
      name: alias,
      local,
      target:
        exported.kind === "module" ? undefined : { moduleId: exported.moduleId, symbol },
      visibility,
      span,
    };
    ctx.imports.push(bound);
    locals.push(bound);
  });

  if (symbols.length > 1 && exported.overloadSet !== undefined) {
    const nextId =
      Math.max(-1, ...ctx.importedOverloadOptions.keys()) + 1;
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

const canAccessExport = ({
  exported,
  moduleId,
  ctx,
}: {
  exported: ModuleExportEntry;
  moduleId: string;
  ctx: BindingContext;
}): boolean => {
  if (moduleId === ctx.module.id) {
    return true;
  }

  const samePackage =
    exported.packageId === ctx.packageId ||
    isSamePackage(exported.modulePath, ctx.modulePath);

  if (samePackage) {
    return isPackageVisible(exported.visibility);
  }

  return isPublicVisibility(exported.visibility);
};

const recordImportDiagnostic = (
  {
    params,
    span,
    ctx,
  }: {
    params: DiagnosticParams<"BD0001">;
    span: SourceSpan;
    ctx: BindingContext;
  }
): void => {
  ctx.diagnostics.push(
    diagnosticFromCode({
      code: "BD0001",
      params,
      span,
    })
  );
};

const matchesDependencyPath = ({
  dependencyPath,
  entry,
  currentModulePath,
}: {
  dependencyPath: ModulePath;
  entry: ParsedUseEntry;
  currentModulePath: ModulePath;
}): boolean => {
  const entryKeys = [
    entry.moduleSegments.length > 0 ? entry.moduleSegments.join("::") : undefined,
    entry.path.length > 0 ? entry.path.join("::") : undefined,
  ].filter((value): value is string => Boolean(value));

  const depSegments = dependencyPath.segments.join("::");
  const namespacedDepKey = [dependencyPath.namespace, ...dependencyPath.segments].join(
    "::"
  );
  if (entryKeys.some((key) => key === depSegments || key === namespacedDepKey)) {
    return true;
  }

  if (dependencyPath.namespace === "pkg" && dependencyPath.packageName) {
    const packageKey = `${dependencyPath.namespace}::${dependencyPath.packageName}`;
    const pkgKey = [dependencyPath.packageName, ...dependencyPath.segments].join("::");
    const namespacedPkgKey = [
      dependencyPath.namespace,
      dependencyPath.packageName,
      ...dependencyPath.segments,
    ].join("::");
    if (
      entryKeys.some(
        (key) =>
          key === packageKey ||
          key === dependencyPath.packageName ||
          key === pkgKey ||
          key === namespacedPkgKey
      )
    ) {
      return true;
    }
  }
  const sameNamespace = dependencyPath.namespace === currentModulePath.namespace;
  const samePackage = dependencyPath.packageName === currentModulePath.packageName;
  if (sameNamespace && samePackage) {
    const hasModulePrefix =
      dependencyPath.segments.length > currentModulePath.segments.length &&
      dependencyPath.segments
        .slice(0, currentModulePath.segments.length)
        .every((segment, index) => segment === currentModulePath.segments[index]);
    if (hasModulePrefix) {
      const relativeSegments = dependencyPath.segments.slice(
        currentModulePath.segments.length
      );
      const relativeKey = relativeSegments.join("::");
      if (entryKeys.some((key) => key === relativeKey)) {
        return true;
      }
    }
  }
  return false;
};
