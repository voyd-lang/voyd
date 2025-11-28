import {
  type Expr,
  type Form,
  type IdentifierAtom,
  type Syntax,
  formCallsInternal,
  isBoolAtom,
  isFloatAtom,
  isForm,
  isIdentifierAtom,
  isIntAtom,
  isStringAtom,
} from "../../parser/index.js";
import { expectLabeledExpr, parseIfBranches, toSourceSpan } from "../utils.js";
import {
  parseFunctionDecl,
  parseObjectDecl,
  parseTypeAliasDecl,
  parseImplDecl,
  parseTraitDecl,
  type ParsedFunctionDecl,
  type ParsedObjectDecl,
  type ParsedTypeAliasDecl,
  type ParsedImplDecl,
  type ParsedTraitDecl,
  type ParsedTraitMethod,
} from "./parsing.js";
import { rememberSyntax } from "./context.js";
import {
  recordFunctionOverload,
  reportOverloadNameCollision,
} from "./overloads.js";
import type { BindingContext } from "./types.js";
import type { ScopeId, SymbolId } from "../ids.js";
import type { SymbolTable } from "../binder/index.js";
import type {
  ObjectFieldDecl,
  ParameterDeclInput,
  TypeParameterDecl,
  TraitMethodDeclInput,
  TraitMethodDecl,
  TraitDecl,
} from "../decls.js";
import { modulePathToString } from "../../modules/path.js";
import type { ModulePath } from "../../modules/types.js";
import type { HirVisibility } from "../hir/index.js";
import type { ModuleExportEntry } from "../modules.js";
import type { SourceSpan } from "../ids.js";

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

  if (tracker.depth() !== 1) {
    throw new Error("binder scope stack imbalance after traversal");
  }
};

class BinderScopeTracker {
  private readonly stack: [ScopeId, ...ScopeId[]];
  constructor(private readonly symbolTable: SymbolTable) {
    this.stack = [symbolTable.rootScope];
  }

  current() {
    return this.stack.at(-1)!;
  }

  depth() {
    return this.stack.length;
  }

  enterScope<T>(scope: ScopeId, runInScope: () => T): T {
    this.push(scope);
    try {
      return runInScope();
    } finally {
      this.pop();
    }
  }

  private push(scope: ScopeId) {
    this.symbolTable.enterScope(scope);
    this.stack.push(scope);
  }

  private pop() {
    if (this.stack.length <= 1) {
      throw new Error("attempted to exit the root scope");
    }
    this.stack.pop();
    this.symbolTable.exitScope();
  }
}

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

type BindFunctionOptions = {
  declarationScope?: ScopeId;
  scopeParent?: ScopeId;
  metadata?: Record<string, unknown>;
  moduleIndex?: number;
  selfTypeExpr?: Expr;
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

const parseUsePaths = (
  expr: Expr,
  span: SourceSpan,
  base: readonly string[] = []
): ParsedUseEntry[] => {
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
    recordImportDiagnostic(
      `Unable to resolve module for use path ${entry.path.join("::")}`,
      entry.span,
      ctx
    );
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
    recordImportDiagnostic(
      `Module ${moduleId} is not available for import`,
      entry.span,
      ctx
    );
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
    recordImportDiagnostic("use entry missing target name", entry.span, ctx);
    return [];
  }

  const exported = exports.get(targetName);
  if (!exported || (exported.visibility !== "public" && moduleId !== ctx.module.id)) {
    recordImportDiagnostic(
      `Module ${moduleId} does not export ${targetName}`,
      entry.span,
      ctx
    );
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
    recordImportDiagnostic("missing module identifier for import", span, ctx);
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
  message: string,
  span: SourceSpan,
  ctx: BindingContext
): void => {
  ctx.diagnostics.push({
    code: "unresolved-import",
    message,
    severity: "error",
    span,
  });
};

const spanKey = (span: SourceSpan): string =>
  `${span.file}:${span.start}:${span.end}`;


const bindFunctionDecl = (
  decl: ParsedFunctionDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
  options: BindFunctionOptions = {}
) => {
  const declarationScope = options.declarationScope ?? tracker.current();
  rememberSyntax(decl.form, ctx);
  const fnSymbol = ctx.symbolTable.declare(
    {
      name: decl.signature.name.value,
      kind: "value",
      declaredAt: decl.form.syntaxId,
      metadata: { entity: "function", ...options.metadata },
    },
    declarationScope
  );

  const fnScope = ctx.symbolTable.createScope({
    parent: options.scopeParent ?? tracker.current(),
    kind: "function",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, fnScope);

  let typeParameters: TypeParameterDecl[] = [];
  let boundParams: ParameterDeclInput[] = [];
  tracker.enterScope(fnScope, () => {
    typeParameters = bindFunctionTypeParameters(decl, ctx);
    boundParams = bindFunctionParameters(decl, ctx, tracker, options);
  });

  const fnDecl = ctx.decls.registerFunction({
    name: decl.signature.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol: fnSymbol,
    scope: fnScope,
    params: boundParams,
    typeParameters,
    returnTypeExpr: decl.signature.returnType,
    body: decl.body,
    moduleIndex: options.moduleIndex ?? ctx.nextModuleIndex++,
    implId: undefined,
  });

  recordFunctionOverload(fnDecl, declarationScope, ctx);
  return fnDecl;
};

const bindFunctionTypeParameters = (
  decl: ParsedFunctionDecl,
  ctx: BindingContext
): TypeParameterDecl[] =>
  bindTypeParameters(decl.signature.typeParameters, ctx);

const bindFunctionParameters = (
  decl: ParsedFunctionDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
  options: BindFunctionOptions = {}
) => {
  const boundParams: ParameterDeclInput[] = [];
  decl.signature.params.forEach((param, index) => {
    const paramSymbol = ctx.symbolTable.declare({
      name: param.name,
      kind: "parameter",
      declaredAt: param.ast.syntaxId,
    });
    rememberSyntax(param.ast, ctx);
    boundParams.push({
      name: param.name,
      label: param.label,
      symbol: paramSymbol,
      ast: param.ast,
      typeExpr:
        param.typeExpr ??
        (options.selfTypeExpr && index === 0 && param.name === "self"
          ? options.selfTypeExpr
          : undefined),
    });
  });

  bindExpr(decl.body, ctx, tracker);

  return boundParams;
};

const bindTypeAlias = (
  decl: ParsedTypeAliasDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.name, ctx);
  rememberSyntax(decl.target as Syntax, ctx);

  const symbol = ctx.symbolTable.declare({
    name: decl.name.value,
    kind: "type",
    declaredAt: decl.form.syntaxId,
    metadata: { entity: "type-alias" },
  });

  const aliasScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "module",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, aliasScope);

  const typeParameters: TypeParameterDecl[] = [];
  tracker.enterScope(aliasScope, () => {
    decl.typeParameters.forEach((param) => {
      rememberSyntax(param, ctx);
      const paramSymbol = ctx.symbolTable.declare({
        name: param.value,
        kind: "type-parameter",
        declaredAt: param.syntaxId,
      });
      typeParameters.push({
        name: param.value,
        symbol: paramSymbol,
        ast: param,
      });
    });
  });

  ctx.decls.registerTypeAlias({
    name: decl.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol,
    target: decl.target,
    typeParameters,
    moduleIndex: ctx.nextModuleIndex++,
  });
};

const bindObjectDecl = (
  decl: ParsedObjectDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.name, ctx);
  rememberSyntax(decl.base, ctx);
  rememberSyntax(decl.body, ctx);

  const symbol = ctx.symbolTable.declare({
    name: decl.name.value,
    kind: "type",
    declaredAt: decl.form.syntaxId,
    metadata: { entity: "object" },
  });

  const objectScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "module",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, objectScope);

  const typeParameters: TypeParameterDecl[] = [];
  const fields: ObjectFieldDecl[] = [];
  tracker.enterScope(objectScope, () => {
    decl.typeParameters.forEach((param) => {
      rememberSyntax(param, ctx);
      const paramSymbol = ctx.symbolTable.declare({
        name: param.value,
        kind: "type-parameter",
        declaredAt: param.syntaxId,
      });
      typeParameters.push({
        name: param.value,
        symbol: paramSymbol,
        ast: param,
      });
    });

    decl.fields.forEach((field) => {
      rememberSyntax(field.ast, ctx);
      rememberSyntax(field.name, ctx);
      rememberSyntax(field.typeExpr as Syntax, ctx);

      const fieldSymbol = ctx.symbolTable.declare({
        name: field.name.value,
        kind: "value",
        declaredAt: field.ast.syntaxId,
        metadata: { entity: "field", owner: symbol },
      });

      fields.push({
        name: field.name.value,
        symbol: fieldSymbol,
        ast: field.ast,
        typeExpr: field.typeExpr,
      });
    });
  });

  ctx.decls.registerObject({
    name: decl.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol,
    baseTypeExpr: decl.base,
    fields,
    typeParameters,
    moduleIndex: ctx.nextModuleIndex++,
  });
};

const bindTraitDecl = (
  decl: ParsedTraitDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.name, ctx);
  rememberSyntax(decl.body, ctx);

  const symbol = ctx.symbolTable.declare({
    name: decl.name.value,
    kind: "trait",
    declaredAt: decl.form.syntaxId,
    metadata: { entity: "trait" },
  });

  const traitScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "trait",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, traitScope);
  ctx.scopeByNode.set(decl.body.syntaxId, traitScope);

  let typeParameters: TypeParameterDecl[] = [];
  const methods: TraitMethodDeclInput[] = [];

  tracker.enterScope(traitScope, () => {
    typeParameters = bindTypeParameters(decl.typeParameters, ctx);

    decl.methods.forEach((method) => {
      methods.push(
        bindTraitMethod({
          decl: method,
          ctx,
          tracker,
          traitScope,
          traitSymbol: symbol,
        })
      );
    });
  });

  ctx.decls.registerTrait({
    name: decl.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol,
    typeParameters,
    methods,
    scope: traitScope,
    moduleIndex: ctx.nextModuleIndex++,
  });
};

const bindTraitMethod = ({
  decl,
  ctx,
  tracker,
  traitScope,
  traitSymbol,
}: {
  decl: ParsedTraitMethod;
  ctx: BindingContext;
  tracker: BinderScopeTracker;
  traitScope: ScopeId;
  traitSymbol: SymbolId;
}): TraitMethodDeclInput => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.body, ctx);

  const methodSymbol = ctx.symbolTable.declare(
    {
      name: decl.signature.name.value,
      kind: "value",
      declaredAt: decl.form.syntaxId,
      metadata: { entity: "trait-method", trait: traitSymbol },
    },
    traitScope
  );

  const methodScope = ctx.symbolTable.createScope({
    parent: traitScope,
    kind: "function",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, methodScope);

  let typeParameters: TypeParameterDecl[] = [];
  let params: ParameterDeclInput[] = [];
  tracker.enterScope(methodScope, () => {
    typeParameters = bindTypeParameters(decl.signature.typeParameters, ctx);
    params = bindTraitMethodParameters(decl, ctx);
    bindExpr(decl.body, ctx, tracker);
  });

  return {
    name: decl.signature.name.value,
    form: decl.form,
    symbol: methodSymbol,
    scope: methodScope,
    nameAst: decl.signature.name,
    params,
    typeParameters,
    returnTypeExpr: decl.signature.returnType,
    defaultBody: decl.body,
  };
};

const bindTraitMethodParameters = (
  decl: ParsedTraitMethod,
  ctx: BindingContext
): ParameterDeclInput[] =>
  decl.signature.params.map((param) => {
    const paramSymbol = ctx.symbolTable.declare({
      name: param.name,
      kind: "parameter",
      declaredAt: param.ast.syntaxId,
    });
    rememberSyntax(param.ast, ctx);
    rememberSyntax(param.typeExpr as Syntax, ctx);
    return {
      name: param.name,
      label: param.label,
      symbol: paramSymbol,
      ast: param.ast,
      typeExpr: param.typeExpr,
    };
  });

const resolveTraitDecl = (
  traitExpr: Expr,
  ctx: BindingContext,
  scope: ScopeId
) => {
  const traitIdentifier = (() => {
    if (isIdentifierAtom(traitExpr)) {
      return traitExpr;
    }
    if (!isForm(traitExpr)) {
      return undefined;
    }
    if (isIdentifierAtom(traitExpr.first)) {
      return traitExpr.first;
    }
    if (traitExpr.callsInternal("generics")) {
      const target = traitExpr.at(1);
      if (isIdentifierAtom(target)) {
        return target;
      }
      if (isForm(target) && isIdentifierAtom(target.first)) {
        return target.first;
      }
    }
    return undefined;
  })();
  if (!traitIdentifier) {
    return undefined;
  }
  const traitSymbol = ctx.symbolTable.resolve(traitIdentifier.value, scope);
  if (typeof traitSymbol !== "number") {
    return undefined;
  }
  const record = ctx.symbolTable.getSymbol(traitSymbol);
  if (record.kind !== "trait") {
    return undefined;
  }
  return ctx.decls.getTrait(record.id);
};

const makeParsedFunctionFromTraitMethod = (
  method: TraitMethodDecl,
  options?: { typeParamSubstitutions?: Map<string, Expr> }
): ParsedFunctionDecl => {
  const nameAst = method.nameAst?.clone();
  if (!nameAst) {
    throw new Error("trait method missing name identifier");
  }

  const clonedDefaultBody = method.defaultBody?.clone();
  const form =
    method.form?.clone() ??
    (isForm(clonedDefaultBody) ? clonedDefaultBody : undefined);
  if (!form) {
    throw new Error("trait method default implementation missing form");
  }

  const signatureParams = method.params.map((param) => {
    if (!param.ast) {
      throw new Error("trait method parameter missing syntax");
    }
    const clonedAst = param.ast.clone();
    const typeExpr = substituteTypeParamExpr(
      param.typeExpr?.clone(),
      options?.typeParamSubstitutions
    );
    return {
      name: param.name,
      label: param.label,
      ast: clonedAst,
      typeExpr,
    };
  });

  const returnType = substituteTypeParamExpr(
    method.returnTypeExpr?.clone(),
    options?.typeParamSubstitutions
  );

  return {
    form,
    visibility: "module",
    signature: {
      name: nameAst,
      typeParameters:
        method.typeParameters
          ?.map((param) => param.ast)
          .filter((entry): entry is IdentifierAtom => Boolean(entry)) ?? [],
      params: signatureParams,
      returnType,
    },
    body: clonedDefaultBody ?? form,
  };
};

const substituteTypeParamExpr = (
  expr: Expr | undefined,
  substitutions?: Map<string, Expr>
): Expr | undefined => {
  if (!expr || !substitutions || substitutions.size === 0) {
    return expr;
  }

  if (isIdentifierAtom(expr)) {
    return substitutions.get(expr.value) ?? expr;
  }
  return expr;
};

const resolveObjectDecl = (
  targetExpr: Expr,
  ctx: BindingContext,
  scope: ScopeId
) => {
  const identifier = (() => {
    if (isIdentifierAtom(targetExpr)) {
      return targetExpr;
    }
    if (!isForm(targetExpr)) {
      return undefined;
    }
    if (isIdentifierAtom(targetExpr.first)) {
      return targetExpr.first;
    }
    if (targetExpr.callsInternal("generics")) {
      const target = targetExpr.at(1);
      if (isIdentifierAtom(target)) {
        return target;
      }
      if (isForm(target) && isIdentifierAtom(target.first)) {
        return target.first;
      }
    }
    return undefined;
  })();
  if (!identifier) {
    return undefined;
  }
  const targetSymbol = ctx.symbolTable.resolve(identifier.value, scope);
  if (typeof targetSymbol !== "number") {
    return undefined;
  }
  const record = ctx.symbolTable.getSymbol(targetSymbol);
  if (
    record.kind !== "type" ||
    (record.metadata as { entity?: string } | undefined)?.entity !== "object"
  ) {
    return undefined;
  }
  return ctx.decls.getObject(record.id);
};

const inferImplTypeParameters = ({
  target,
  trait,
  ctx,
  scope,
}: {
  target: Expr;
  trait?: Expr;
  ctx: BindingContext;
  scope: ScopeId;
}): string[] => {
  const inferred = new Set<string>();

  const targetDecl = resolveObjectDecl(target, ctx, scope);
  if (targetDecl?.typeParameters?.length) {
    const args = extractTraitTypeArguments(target);
    if (args.length === targetDecl.typeParameters.length) {
      targetDecl.typeParameters.forEach((param, index) => {
        const arg = args[index];
        if (isIdentifierAtom(arg) && arg.value === param.name) {
          inferred.add(param.name);
        }
      });
    }
  }

  const traitDecl = trait ? resolveTraitDecl(trait, ctx, scope) : undefined;
  if (traitDecl?.typeParameters?.length) {
    const args = trait ? extractTraitTypeArguments(trait) : [];
    if (args.length === traitDecl.typeParameters.length) {
      traitDecl.typeParameters.forEach((param, index) => {
        const arg = args[index];
        if (isIdentifierAtom(arg) && arg.value === param.name) {
          inferred.add(param.name);
        }
      });
    }
  }

  return Array.from(inferred);
};

const bindImplDecl = (
  decl: ParsedImplDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.target as Syntax, ctx);
  rememberSyntax(decl.trait as Syntax, ctx);
  rememberSyntax(decl.body, ctx);

  const implName = isIdentifierAtom(decl.target)
    ? `${decl.target.value}::impl`
    : `impl#${decl.form.syntaxId}`;

  const implSymbol = ctx.symbolTable.declare(
    {
      name: implName,
      kind: "impl",
      declaredAt: decl.form.syntaxId,
      metadata: { entity: "impl" },
    },
    tracker.current()
  );

  const implScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "impl",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, implScope);
  ctx.scopeByNode.set(decl.body.syntaxId, implScope);

  const typeParameters: TypeParameterDecl[] = [];
  const methods: ReturnType<typeof bindFunctionDecl>[] = [];
  const inferredTypeParams = inferImplTypeParameters({
    target: decl.target,
    trait: decl.trait,
    ctx,
    scope: implScope,
  });
  tracker.enterScope(implScope, () => {
    decl.typeParameters.forEach((param) => {
      rememberSyntax(param, ctx);
      const paramSymbol = ctx.symbolTable.declare({
        name: param.value,
        kind: "type-parameter",
        declaredAt: param.syntaxId,
      });
      typeParameters.push({
        name: param.value,
        symbol: paramSymbol,
        ast: param,
      });
    });

    inferredTypeParams.forEach((name) => {
      if (typeParameters.some((param) => param.name === name)) {
        return;
      }
      const paramSymbol = ctx.symbolTable.declare({
        name,
        kind: "type-parameter",
        declaredAt: decl.form?.syntaxId ?? decl.target.syntaxId,
      });
      typeParameters.push({ name, symbol: paramSymbol });
    });

    decl.body.rest.forEach((entry) => {
      if (!isForm(entry)) {
        return;
      }
      const parsedFn = parseFunctionDecl(entry);
      if (!parsedFn) {
        throw new Error("impl body supports only function declarations");
      }
      const method = bindFunctionDecl(parsedFn, ctx, tracker, {
        declarationScope: ctx.symbolTable.rootScope,
        scopeParent: implScope,
        metadata: { entity: "function", impl: implSymbol },
        selfTypeExpr: decl.target,
      });
      methods.push(method);
    });

    if (decl.trait) {
      const traitDecl = resolveTraitDecl(decl.trait, ctx, tracker.current());
      if (traitDecl) {
        const traitTypeParamMap = buildTraitTypeParamMap(traitDecl, decl.trait);
        const methodNames = new Set(
          methods.map((method) => ctx.symbolTable.getSymbol(method.symbol).name)
        );
        traitDecl.methods.forEach((traitMethod) => {
          if (!traitMethod.defaultBody) {
            return;
          }
          const name = ctx.symbolTable.getSymbol(traitMethod.symbol).name;
          if (methodNames.has(name)) {
            return;
          }
          const parsed = makeParsedFunctionFromTraitMethod(traitMethod, {
            typeParamSubstitutions: traitTypeParamMap,
          });
          const method = bindFunctionDecl(parsed, ctx, tracker, {
            declarationScope: ctx.symbolTable.rootScope,
            scopeParent: implScope,
            metadata: { entity: "function", impl: implSymbol },
            selfTypeExpr: decl.target,
          });
          methods.push(method);
        });
      }
    }
  });

  const implDecl = ctx.decls.registerImpl({
    form: decl.form,
    visibility: decl.visibility,
    symbol: implSymbol,
    target: decl.target,
    trait: decl.trait,
    typeParameters,
    methods,
    scope: implScope,
    moduleIndex: ctx.nextModuleIndex++,
  });

  methods.forEach((method) => {
    method.implId = implDecl.id;
  });
};

const buildTraitTypeParamMap = (
  traitDecl: TraitDecl,
  traitExpr: Expr
): Map<string, Expr> | undefined => {
  const params = traitDecl.typeParameters ?? [];
  if (params.length === 0) {
    return undefined;
  }
  const args = extractTraitTypeArguments(traitExpr);
  if (args.length === 0) {
    return undefined;
  }

  const substitutions = new Map<string, Expr>();
  params.forEach((param, index) => {
    const arg = args[index];
    if (arg) {
      substitutions.set(param.name, arg);
    }
  });
  return substitutions.size > 0 ? substitutions : undefined;
};

const extractTraitTypeArguments = (traitExpr: Expr): readonly Expr[] => {
  if (isForm(traitExpr) && isIdentifierAtom(traitExpr.first)) {
    if (
      isForm(traitExpr.second) &&
      formCallsInternal(traitExpr.second, "generics")
    ) {
      return traitExpr.second.rest;
    }
    return [];
  }

  if (isForm(traitExpr) && formCallsInternal(traitExpr, "generics")) {
    return traitExpr.rest;
  }

  return [];
};

const bindExpr = (
  expr: Expr | undefined,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  if (!expr || !isForm(expr)) return;

  if (expr.calls("block")) {
    bindBlock(expr, ctx, tracker);
    return;
  }

  if (expr.calls("if")) {
    bindIf(expr, ctx, tracker);
    return;
  }

  if (expr.calls("match")) {
    bindMatch(expr, ctx, tracker);
    return;
  }

  if (expr.calls("while")) {
    bindWhile(expr, ctx, tracker);
    return;
  }

  if (expr.calls("var") || expr.calls("let")) {
    bindVar(expr, ctx, tracker);
    return;
  }

  for (const child of expr.toArray()) {
    bindExpr(child, ctx, tracker);
  }
};

const bindBlock = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  const scope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "block",
    owner: form.syntaxId,
  });
  ctx.scopeByNode.set(form.syntaxId, scope);

  tracker.enterScope(scope, () => {
    for (const child of form.rest) {
      bindExpr(child, ctx, tracker);
    }
  });
};

const bindIf = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  const { branches, defaultBranch } = parseIfBranches(form);
  branches.forEach(({ condition, value }) => {
    bindExpr(condition, ctx, tracker);
    bindExpr(value, ctx, tracker);
  });

  if (defaultBranch) {
    bindExpr(defaultBranch, ctx, tracker);
  }
};

const bindMatch = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  const operandExpr = form.at(1);
  const potentialBinder = form.at(2);
  const hasBinder = isIdentifierAtom(potentialBinder);
  const caseStartIndex = hasBinder ? 3 : 2;

  const matchScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "block",
    owner: form.syntaxId,
  });
  ctx.scopeByNode.set(form.syntaxId, matchScope);

  tracker.enterScope(matchScope, () => {
    bindExpr(operandExpr, ctx, tracker);

    if (hasBinder) {
      rememberSyntax(potentialBinder as Syntax, ctx);
      reportOverloadNameCollision(
        potentialBinder.value,
        matchScope,
        potentialBinder,
        ctx
      );
      ctx.symbolTable.declare({
        name: potentialBinder.value,
        kind: "value",
        declaredAt: potentialBinder.syntaxId,
      });
    }

    for (let index = caseStartIndex; index < form.length; index += 1) {
      const arm = form.at(index);
      if (!isForm(arm) || !arm.calls(":")) {
        throw new Error("match cases must be labeled with ':'");
      }

      const caseScope = ctx.symbolTable.createScope({
        parent: matchScope,
        kind: "block",
        owner: arm.syntaxId,
      });
      ctx.scopeByNode.set(arm.syntaxId, caseScope);

      tracker.enterScope(caseScope, () => {
        const valueExpr = arm.at(2);
        bindExpr(valueExpr, ctx, tracker);
      });
    }
  });
};

const bindWhile = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  const condition = form.at(1);
  if (!condition) {
    throw new Error("while expression missing condition");
  }

  const body = expectLabeledExpr(form.at(2), "do", "while expression");

  bindExpr(condition, ctx, tracker);
  bindExpr(body, ctx, tracker);
};

const bindVar = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  const assignment = ensureForm(
    form.at(1),
    "var statement expects an assignment"
  );
  if (!assignment.calls("=")) {
    throw new Error("var statement must be an assignment form");
  }

  const patternExpr = assignment.at(1);
  const initializer = assignment.at(2);
  declarePatternBindings(patternExpr, ctx, tracker.current());
  bindExpr(initializer, ctx, tracker);
};

const declarePatternBindings = (
  pattern: Expr | undefined,
  ctx: BindingContext,
  scope: ScopeId
): void => {
  if (!pattern) {
    throw new Error("missing pattern");
  }

  if (isIdentifierAtom(pattern)) {
    if (pattern.value === "_") {
      return;
    }
    rememberSyntax(pattern, ctx);
    reportOverloadNameCollision(pattern.value, scope, pattern, ctx);
    ctx.symbolTable.declare({
      name: pattern.value,
      kind: "value",
      declaredAt: pattern.syntaxId,
    });
    return;
  }

  if (
    isForm(pattern) &&
    (pattern.calls("tuple") || pattern.callsInternal("tuple"))
  ) {
    pattern.rest.forEach((entry) => declarePatternBindings(entry, ctx, scope));
    return;
  }

  if (isForm(pattern) && pattern.calls(":")) {
    const nameExpr = pattern.at(1);
    const typeExpr = pattern.at(2);
    if (!isIdentifierAtom(nameExpr)) {
      throw new Error("typed pattern name must be an identifier");
    }
    rememberSyntax(nameExpr, ctx);
    rememberSyntax(typeExpr as Syntax, ctx);
    reportOverloadNameCollision(nameExpr.value, scope, pattern, ctx);
    ctx.symbolTable.declare({
      name: nameExpr.value,
      kind: "value",
      declaredAt: pattern.syntaxId,
    });
    return;
  }

  throw new Error("unsupported pattern form in declaration");
};

const bindTypeParameters = (
  params: readonly IdentifierAtom[],
  ctx: BindingContext
): TypeParameterDecl[] =>
  params.map((param) => {
    rememberSyntax(param, ctx);
    const paramSymbol = ctx.symbolTable.declare({
      name: param.value,
      kind: "type-parameter",
      declaredAt: param.syntaxId,
    });
    return {
      name: param.value,
      symbol: paramSymbol,
      ast: param,
    };
  });

const ensureForm = (expr: Expr | undefined, message: string): Form => {
  if (!isForm(expr)) {
    throw new Error(message);
  }
  return expr;
};
