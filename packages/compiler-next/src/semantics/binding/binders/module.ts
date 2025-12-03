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
} from "../parsing.js";
import { bindFunctionDecl } from "./function.js";
import { bindObjectDecl } from "./object.js";
import { bindTypeAlias } from "./type-alias.js";
import {
  bindTraitDecl,
} from "./trait.js";
import { bindImplDecl, flushPendingStaticMethods } from "./impl.js";
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
import type { HirVisibility } from "../../hir/index.js";
import type { ModuleExportEntry } from "../../modules.js";
import type { SourceSpan } from "../../ids.js";
import { BinderScopeTracker } from "./scope-tracker.js";

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

    throw new Error(
      "unsupported top-level form; expected a function or type declaration"
    );
  }

  flushPendingStaticMethods(ctx);

  if (tracker.depth() !== 1) {
    throw new Error("binder scope stack imbalance after traversal");
  }
};

type ParsedUseEntry = {
  moduleSegments: readonly string[];
  path: readonly string[];
  targetName?: string;
  alias?: string;
  importKind: "all" | "self" | "name";
  span: SourceSpan;
};

type ParsedUseDecl = {
  form: Form;
  visibility: HirVisibility;
  entries: readonly ParsedUseEntry[];
};

const parseUseDecl = (form: Form): ParsedUseDecl | null => {
  let index = 0;
  let visibility: HirVisibility = "module";
  const first = form.at(0);

  if (isIdentifierAtom(first) && first.value === "pub") {
    visibility = "public";
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
  let visibility: HirVisibility = "module";
  const first = form.at(0);

  if (isIdentifierAtom(first) && first.value === "pub") {
    visibility = "public";
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

const parseUsePaths = (
  expr: Expr | undefined,
  span: SourceSpan,
  base: readonly string[] = []
): ParsedUseEntry[] => {
  if (!expr) {
    return [];
  }
  if (isIdentifierAtom(expr)) {
    return [normalizeUseEntry({ segments: [...base, expr.value], span })];
  }

  if (!isForm(expr)) {
    return [];
  }

  if (expr.calls("::")) {
    const left = parseUsePaths(expr.at(1), span, base);
    return left.flatMap((entry) =>
      parseUsePaths(expr.at(2), span, entry.path)
    );
  }

  if (expr.calls("as")) {
    const aliasExpr = expr.at(2);
    const alias = isIdentifierAtom(aliasExpr) ? aliasExpr.value : undefined;
    return parseUsePaths(expr.at(1), span, base).map((entry) => ({
      ...entry,
      alias: alias ?? entry.alias,
    }));
  }

  if (expr.callsInternal("object_literal")) {
    return expr.rest.flatMap((entry) => parseUsePaths(entry, span, base));
  }

  return [];
};

const normalizeUseEntry = ({
  segments,
  span,
  alias,
}: {
  segments: readonly string[];
  span: SourceSpan;
  alias?: string;
}): ParsedUseEntry => {
  const last = segments.at(-1);
  if (last === "all") {
    const moduleSegments = segments.slice(0, -1);
    return {
      moduleSegments,
      path: moduleSegments,
      importKind: "all",
      alias,
      span,
    };
  }

  if (last === "self") {
    const moduleSegments = segments.slice(0, -1);
    const name = moduleSegments.at(-1) ?? "self";
    return {
      moduleSegments,
      path: moduleSegments,
      importKind: "self",
      alias: alias ?? name,
      span,
    };
  }

  if (segments.length === 1 && last) {
    return {
      moduleSegments: segments,
      path: segments,
      targetName: last,
      alias: alias ?? last,
      importKind: "self",
      span,
    };
  }

  const targetName = last;
  const moduleSegments = segments.slice(0, -1);
  const name = targetName ?? segments.at(-1) ?? "self";
  return {
    moduleSegments,
    path: targetName ? [...moduleSegments, targetName] : moduleSegments,
    targetName,
    alias: alias ?? name,
    importKind: "name",
    span,
  };
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
  const dependencyPath = takeDependencyPath(entry.span, ctx);
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

const takeDependencyPath = (
  span: SourceSpan,
  ctx: BindingContext
): ModulePath | undefined => {
  const bucket = ctx.dependenciesBySpan.get(spanKey(span));
  if (!bucket || bucket.length === 0) {
    return undefined;
  }
  const dep = bucket.shift();
  return dep?.path;
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

  if (entry.importKind === "all") {
    const allowed = Array.from(exports.values()).filter(
      (item) =>
        item.visibility === "public" || moduleId === ctx.module.id
    );
    return allowed.map((item) =>
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
  if (!exported || (exported.visibility !== "public" && moduleId !== ctx.module.id)) {
    recordImportDiagnostic({
      params: { kind: "missing-export", moduleId, target: targetName },
      span: entry.span,
      ctx,
    });
    return [];
  }

  return [
    declareImportedSymbol({
      exported,
      alias: entry.alias ?? targetName,
      ctx,
      declaredAt,
      span: entry.span,
      visibility,
    }),
  ];
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
}): BoundImport => {
  const local = ctx.symbolTable.declare({
    name: alias,
    kind: exported.kind,
    declaredAt: declaredAt.syntaxId,
    metadata: {
      import: { moduleId: exported.moduleId, symbol: exported.symbol },
    },
  });
  const bound: BoundImport = {
    name: alias,
    local,
    target: { moduleId: exported.moduleId, symbol: exported.symbol },
    visibility,
    span,
  };
  ctx.imports.push(bound);
  return bound;
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

const spanKey = (span: SourceSpan): string =>
  `${span.file}:${span.start}:${span.end}`;
