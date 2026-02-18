import {
  type Expr,
  type Form,
  type IdentifierAtom,
  type Syntax,
  type InternalIdentifierAtom,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../../../parser/index.js";
import {
  expectLabeledExpr,
  parseIfBranches,
  parseWhileConditionAndBody,
  toSourceSpan,
} from "../../utils.js";
import { diagnosticFromCode } from "../../../diagnostics/index.js";
import { rememberSyntax } from "../context.js";
import { declareValueOrParameter } from "../redefinitions.js";
import type { BindingContext } from "../types.js";
import type { ScopeId, SymbolId } from "../../ids.js";
import { parseLambdaSignature } from "../../lambda.js";
import { ensureForm } from "./utils.js";
import type { BinderScopeTracker } from "./scope-tracker.js";
import {
  type HirBindingKind,
  isPublicVisibility,
  isPackageVisible,
  moduleVisibility,
} from "../../hir/index.js";
import type { ModuleExportEntry } from "../../modules.js";
import type { ModuleMemberTable } from "../types.js";
import { extractConstructorTargetIdentifier } from "../../constructors.js";
import {
  importableMetadataFrom,
  importedModuleIdFrom,
} from "../../imports/metadata.js";
import {
  enumVariantTypeNamesFromAliasTarget,
  importedSymbolTargetFromMetadata,
} from "../../enum-namespace.js";

export const bindExpr = (
  expr: Expr | undefined,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  if (!expr || !isForm(expr)) return;

  if (expr.calls("::")) {
    bindNamespaceAccess(expr, ctx, tracker);
    return;
  }

  if (expr.calls("block")) {
    bindBlock(expr, ctx, tracker);
    return;
  }

  if (expr.calls("try")) {
    bindTry(expr, ctx, tracker);
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

  if (expr.calls("=>")) {
    bindLambda(expr, ctx, tracker);
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

  if (isForm(expr)) {
    maybeBindConstructorCall(expr, ctx, tracker);
  }

  for (const child of expr.toArray()) {
    bindExpr(child, ctx, tracker);
  }
};

const bindTry = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  const handlerEntries: Form[] = [];
  const body = form.at(1);
  if (isForm(body) && body.calls("block")) {
    body.rest.forEach((entry) => {
      if (isForm(entry) && entry.calls(":")) {
        handlerEntries.push(entry);
      }
    });
  }
  if (body) {
    handlerEntries.push(...findHandlerClauses(body));
  }
  if (body) {
    bindExpr(body, ctx, tracker);
  }

  handlerEntries.push(
    ...form.rest.slice(1).filter((entry): entry is Form => isForm(entry)),
  );
  handlerEntries.forEach((entry) => {
    if (!isForm(entry) || !entry.calls(":")) {
      bindExpr(entry, ctx, tracker);
      return;
    }
    const clauseScope = ctx.symbolTable.createScope({
      parent: tracker.current(),
      kind: "block",
      owner: entry.syntaxId,
    });
    ctx.scopeByNode.set(entry.syntaxId, clauseScope);

    const head = entry.at(1);
    const handlerBody = entry.at(2);

    tracker.enterScope(clauseScope, () => {
      declareHandlerParams(head, ctx, clauseScope);
      bindExpr(handlerBody, ctx, tracker);
    });
  });
};

const declareHandlerParams = (
  head: Expr | undefined,
  ctx: BindingContext,
  scope: number,
): void => {
  if (!head || (!isForm(head) && !isIdentifierAtom(head))) {
    return;
  }
  const params = extractHandlerParams(head);
  params.forEach((param) => {
    const nameExpr = (() => {
      if (!param) {
        return undefined;
      }
      if (isIdentifierAtom(param) || isInternalIdentifierAtom(param)) {
        return param;
      }
      if (isForm(param) && param.calls(":")) {
        const candidate = param.at(1);
        return isIdentifierAtom(candidate) ||
          isInternalIdentifierAtom(candidate)
          ? candidate
          : undefined;
      }
      return undefined;
    })();
    if (!nameExpr) return;
    rememberSyntax(nameExpr, ctx);
    declareValueOrParameter({
      name: nameExpr.value,
      kind: "parameter",
      declaredAt: nameExpr.syntaxId,
      metadata: { declarationSpan: toSourceSpan(nameExpr as Syntax) },
      scope,
      syntax: nameExpr,
      ctx,
    });
    ctx.scopeByNode.set(nameExpr.syntaxId, scope);
  });
};

const extractHandlerParams = (
  head: Expr,
): readonly (IdentifierAtom | InternalIdentifierAtom | Expr)[] => {
  if (isForm(head) && head.calls("::")) {
    const opCall = head.at(2);
    return isForm(opCall) ? opCall.rest : [];
  }
  if (isForm(head)) {
    return head.rest;
  }
  return [];
};

const findHandlerClauses = (expr: Expr): Form[] => {
  if (!isForm(expr)) {
    return [];
  }
  const handlers: Form[] = [];
  expr.toArray().forEach((child) => {
    if (isForm(child) && child.calls(":")) {
      const body = child.at(2);
      if (isForm(body) && body.calls("block")) {
        handlers.push(child);
        return;
      }
    }
    handlers.push(...findHandlerClauses(child));
  });
  return handlers;
};

const bindBlock = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  const scope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "block",
    owner: form.syntaxId,
  });
  ctx.scopeByNode.set(form.syntaxId, scope);

  tracker.enterScope(scope, () => {
    for (const child of form.rest) {
      if (isForm(child) && child.calls(":")) {
        continue;
      }
      bindExpr(child, ctx, tracker);
    }
  });
};

const bindIf = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
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
  tracker: BinderScopeTracker,
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
      declareValueOrParameter({
        name: potentialBinder.value,
        kind: "value",
        declaredAt: potentialBinder.syntaxId,
        metadata: {
          declarationSpan: toSourceSpan(potentialBinder),
        },
        scope: matchScope,
        syntax: potentialBinder,
        ctx,
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
        const patternExpr = arm.at(1);
        declareMatchPatternBindings(patternExpr, ctx, caseScope);
        const valueExpr = arm.at(2);
        bindExpr(valueExpr, ctx, tracker);
      });
    }
  });
};

const bindWhile = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  const { condition, body } = parseWhileConditionAndBody(form);

  bindExpr(condition, ctx, tracker);
  bindExpr(body, ctx, tracker);
};

const bindVar = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  const assignment = ensureForm(
    form.at(1),
    "var statement expects an assignment",
  );
  if (!assignment.calls("=")) {
    throw new Error("var statement must be an assignment form");
  }

  const isVar = form.calls("var");
  const isLet = form.calls("let");
  const patternExpr = assignment.at(1);
  const initializer = assignment.at(2);
  declarePatternBindings(patternExpr, ctx, tracker.current(), {
    mutable: isVar && !isLet,
    declarationSpan: toSourceSpan(patternExpr as Syntax),
  });
  bindExpr(initializer, ctx, tracker);
};

const bindLambda = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  const signatureExpr = form.at(1);
  const bodyExpr = form.at(2);
  if (!signatureExpr || !bodyExpr) {
    throw new Error("lambda expression missing signature or body");
  }

  rememberSyntax(form, ctx);
  rememberSyntax(signatureExpr as Syntax, ctx);
  rememberSyntax(bodyExpr as Syntax, ctx);

  const signature = parseLambdaSignature(signatureExpr);
  const scope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "lambda",
    owner: form.syntaxId,
  });
  ctx.scopeByNode.set(form.syntaxId, scope);

  tracker.enterScope(scope, () => {
    signature.typeParameters?.forEach((param) => {
      rememberSyntax(param, ctx);
      ctx.symbolTable.declare({
        name: param.value,
        kind: "type-parameter",
        declaredAt: param.syntaxId,
      });
    });

    signature.parameters.forEach((param) =>
      declareLambdaParam(param, scope, ctx),
    );
    bindExpr(bodyExpr, ctx, tracker);
  });
};

const declareLambdaParam = (
  param: Expr,
  scope: ScopeId,
  ctx: BindingContext,
): void => {
  const declarationSpan = toSourceSpan(param as Syntax);

  if (isIdentifierAtom(param)) {
    rememberSyntax(param, ctx);
    declareValueOrParameter({
      name: param.value,
      kind: "parameter",
      declaredAt: param.syntaxId,
      metadata: { declarationSpan },
      scope,
      syntax: param,
      ctx,
    });
    return;
  }

  if (isForm(param) && param.calls("~")) {
    rememberSyntax(param, ctx);
    const target = param.at(1);
    if (!isIdentifierAtom(target)) {
      throw new Error("lambda parameter name must be an identifier");
    }
    rememberSyntax(target, ctx);
    declareValueOrParameter({
      name: target.value,
      kind: "parameter",
      declaredAt: param.syntaxId,
      metadata: { bindingKind: "mutable-ref", declarationSpan },
      scope,
      syntax: param,
      ctx,
    });
    return;
  }

  if (isForm(param) && (param.calls(":") || param.calls("?:"))) {
    rememberSyntax(param, ctx);
    const nameExpr = param.at(1);
    const { target, bindingKind } = unwrapMutablePattern(nameExpr);
    if (!isIdentifierAtom(target)) {
      throw new Error("lambda parameter name must be an identifier");
    }
    rememberSyntax(target, ctx);
    rememberSyntax(param.at(2) as Syntax, ctx);
    declareValueOrParameter({
      name: target.value,
      kind: "parameter",
      declaredAt: param.syntaxId,
      metadata: { bindingKind, declarationSpan },
      scope,
      syntax: param,
      ctx,
    });
    return;
  }

  if (isForm(param)) {
    param.toArray().forEach((entry) => declareLambdaParam(entry, scope, ctx));
    return;
  }

  throw new Error("unsupported lambda parameter form");
};

const maybeBindConstructorCall = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  if (form.length < 2) {
    return;
  }
  const callee = form.at(0);
  const identifier = extractConstructorTargetIdentifier(callee);
  ensureConstructorImportForTarget({
    identifier,
    ctx,
    scope: tracker.current(),
  });
};

const bindNamespaceAccess = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  const target = form.at(1);
  const member = form.at(2);

  bindExpr(target, ctx, tracker);
  bindExpr(member, ctx, tracker);

  const memberName = extractMemberName(member);
  if (!memberName) {
    return;
  }

  const scope = tracker.current();

  const moduleSymbol = resolveNamespaceModuleSymbol(target, scope, ctx);
  if (typeof moduleSymbol === "number") {
    const targetRecord = ctx.symbolTable.getSymbol(moduleSymbol);
    const importMeta = targetRecord.metadata as {
      import?: { moduleId?: string };
    };
    const moduleId = importMeta.import?.moduleId;
    if (!moduleId) {
      return;
    }

    ensureModuleMemberImport({
      moduleId,
      moduleSymbol,
      memberName,
      syntax: member as Syntax,
      scope,
      ctx,
    });
    ensureConstructorImportForTarget({
      identifier: extractConstructorTargetIdentifier(member),
      ctx,
      scope,
    });
    return;
  }

  const identifier = extractConstructorTargetIdentifier(target);
  if (!identifier) {
    return;
  }

  const targetSymbol = ctx.symbolTable.resolve(identifier.value, scope);
  if (typeof targetSymbol !== "number") {
    return;
  }

  const targetRecord = ctx.symbolTable.getSymbol(targetSymbol);
  if (targetRecord.kind !== "type") {
    return;
  }

  ensureStaticMethodImport({
    targetSymbol,
    memberName,
    syntax: member as Syntax,
    scope,
    ctx,
  });
  ensureEnumNamespaceImport({
    targetSymbol,
    memberName,
    syntax: member as Syntax,
    scope,
    ctx,
  });
};

const resolveNamespaceModuleSymbol = (
  target: Expr | undefined,
  scope: ScopeId,
  ctx: BindingContext,
): number | undefined => {
  if (!target) {
    return undefined;
  }

  const stripped = stripTypeArguments(target);
  if (stripped !== target) {
    return resolveNamespaceModuleSymbol(stripped, scope, ctx);
  }

  if (isIdentifierAtom(target) || isInternalIdentifierAtom(target)) {
    const symbol = ctx.symbolTable.resolve(target.value, scope);
    if (typeof symbol !== "number") {
      return undefined;
    }
    const record = ctx.symbolTable.getSymbol(symbol);
    if (record.kind !== "module" && record.kind !== "effect") {
      return undefined;
    }
    if (!record.metadata || !("import" in record.metadata)) {
      return undefined;
    }
    return symbol;
  }

  if (!isForm(target) || !target.calls("::") || target.length !== 3) {
    return undefined;
  }

  const left = target.at(1);
  const right = target.at(2);
  if (!left || !right) {
    return undefined;
  }

  const leftSymbol = resolveNamespaceModuleSymbol(left, scope, ctx);
  if (typeof leftSymbol !== "number") {
    return undefined;
  }

  const memberName = extractMemberName(right);
  if (!memberName) {
    return undefined;
  }

  const memberTable = ctx.moduleMembers.get(leftSymbol);
  const candidates = memberTable?.get(memberName);
  if (!candidates) {
    return undefined;
  }

  for (const candidate of candidates) {
    const record = ctx.symbolTable.getSymbol(candidate);
    if (record.kind !== "module" && record.kind !== "effect") {
      continue;
    }
    if (!record.metadata || !("import" in record.metadata)) {
      continue;
    }
    return candidate;
  }

  return undefined;
};

const stripTypeArguments = (expr: Expr): Expr => {
  if (!isForm(expr)) {
    return expr;
  }

  if (formCallsInternal(expr, "generics")) {
    const target = expr.at(1);
    return target ?? expr;
  }

  const head = expr.at(0);
  const second = expr.at(1);
  if (
    expr.length === 2 &&
    (isIdentifierAtom(head) || isInternalIdentifierAtom(head)) &&
    isForm(second) &&
    formCallsInternal(second, "generics")
  ) {
    return head;
  }

  return expr;
};

type ImportMeta = { import?: { moduleId?: string; symbol?: number } };

const ensureStaticMethodImport = ({
  targetSymbol,
  memberName,
  syntax,
  scope,
  ctx,
}: {
  targetSymbol: number;
  memberName: string;
  syntax: Syntax;
  scope: ScopeId;
  ctx: BindingContext;
}): void => {
  const targetRecord = ctx.symbolTable.getSymbol(targetSymbol);
  const importMeta = targetRecord.metadata as ImportMeta | undefined;
  const moduleId = importMeta?.import?.moduleId;
  const exportedSymbol = importMeta?.import?.symbol;
  if (!moduleId || typeof exportedSymbol !== "number") {
    return;
  }

  const dependency = ctx.dependencies.get(moduleId);
  const staticTable = dependency?.staticMethods.get(exportedSymbol);
  const methodSymbols = staticTable?.get(memberName);
  if (!dependency || !methodSymbols || methodSymbols.size === 0) {
    return;
  }

  const existing = ctx.staticMethods.get(targetSymbol)?.get(memberName);
  if (existing?.size) {
    return;
  }

  const imported: { local: SymbolId; overloadId?: number }[] = [];
  methodSymbols.forEach((methodSymbol) => {
    const fn = dependency.functions.find(
      (entry) => entry.symbol === methodSymbol,
    );
    if (!fn) {
      return;
    }
    const samePackage = dependency.packageId === ctx.packageId;
    const visibilityAllowed =
      isPublicVisibility(fn.visibility) ||
      fn.visibility.api === true ||
      (samePackage && isPackageVisible(fn.visibility));
    if (!visibilityAllowed) {
      return;
    }
    const record = dependency.symbolTable.getSymbol(methodSymbol);
    const local = ctx.symbolTable.declare(
      {
        name: memberName,
        kind: record.kind,
        declaredAt: syntax.syntaxId,
        metadata: { import: { moduleId, symbol: methodSymbol } },
      },
      scope,
    );
    ctx.imports.push({
      name: memberName,
      local,
      target: { moduleId, symbol: methodSymbol },
      visibility: moduleVisibility(),
      span: toSourceSpan(syntax),
    });
    const overloadId = dependency.overloadBySymbol.get(methodSymbol);
    imported.push({ local, overloadId });
  });

  if (imported.length === 0) {
    return;
  }

  const locals = imported.map((entry) => entry.local);
  const bucket = ctx.staticMethods.get(targetSymbol) ?? new Map();
  bucket.set(memberName, new Set(locals));
  ctx.staticMethods.set(targetSymbol, bucket);

  const importedOverloadIds = new Set(
    imported
      .map((entry) => entry.overloadId)
      .filter((entry): entry is number => typeof entry === "number"),
  );
  const needsImportedSet = locals.length > 1 || importedOverloadIds.size === 1;
  if (needsImportedSet) {
    const nextId =
      Math.max(
        -1,
        ...ctx.importedOverloadOptions.keys(),
        ...ctx.overloads.keys(),
      ) + 1;
    const setId = importedOverloadIds.size === 1 ? nextId : nextId;
    const existing = ctx.importedOverloadOptions.get(setId);
    const merged = existing
      ? Array.from(new Set([...existing, ...locals]))
      : locals;
    ctx.importedOverloadOptions.set(setId, merged);
    merged.forEach((local) => ctx.overloadBySymbol.set(local, setId));
  }
};

const ensureEnumNamespaceImport = ({
  targetSymbol,
  memberName,
  syntax,
  scope,
  ctx,
}: {
  targetSymbol: number;
  memberName: string;
  syntax: Syntax;
  scope: ScopeId;
  ctx: BindingContext;
}): void => {
  const existing = ctx.staticMethods.get(targetSymbol)?.get(memberName);
  if (existing?.size) {
    return;
  }

  const targetRecord = ctx.symbolTable.getSymbol(targetSymbol);
  const importedTarget = importedSymbolTargetFromMetadata(
    targetRecord.metadata as Record<string, unknown> | undefined,
  );
  if (!importedTarget) {
    return;
  }

  const dependency = ctx.dependencies.get(importedTarget.moduleId);
  if (!dependency) {
    return;
  }

  const aliasDecl = dependency.decls.getTypeAlias(importedTarget.symbol);
  if (!aliasDecl) {
    return;
  }

  const variantNames = enumVariantTypeNamesFromAliasTarget(aliasDecl.target);
  if (!variantNames || !variantNames.includes(memberName)) {
    return;
  }

  const exportTable = ctx.moduleExports.get(importedTarget.moduleId);
  const exported = exportTable?.get(memberName);
  if (!exported) {
    return;
  }

  const exportedRecord = dependency.symbolTable.getSymbol(exported.symbol);
  const metadata = exportedRecord.metadata as { entity?: string } | undefined;
  if (exportedRecord.kind !== "type" || metadata?.entity !== "object") {
    return;
  }

  const locals = declareModuleMemberImport({
    exported,
    syntax,
    scope,
    ctx,
  });
  if (locals.length === 0) {
    return;
  }

  const bucket = ctx.staticMethods.get(targetSymbol) ?? new Map();
  const members = bucket.get(memberName) ?? new Set<SymbolId>();
  locals.forEach((local) => members.add(local));
  bucket.set(memberName, members);
  ctx.staticMethods.set(targetSymbol, bucket);
};

const ensureConstructorImport = ({
  targetSymbol,
  syntax,
  scope,
  ctx,
}: {
  targetSymbol: number;
  syntax: Syntax;
  scope: ScopeId;
  ctx: BindingContext;
}): void => {
  const constructors = ctx.staticMethods.get(targetSymbol)?.get("init");
  if (constructors?.size) {
    return;
  }
  ensureStaticMethodImport({
    targetSymbol,
    memberName: "init",
    syntax,
    scope,
    ctx,
  });
};

const ensureConstructorImportForTarget = ({
  identifier,
  ctx,
  scope,
}: {
  identifier?: IdentifierAtom | InternalIdentifierAtom;
  ctx: BindingContext;
  scope: ScopeId;
}): void => {
  if (!identifier) {
    return;
  }
  const targetSymbol = ctx.symbolTable.resolve(identifier.value, scope);
  if (typeof targetSymbol !== "number") {
    return;
  }
  const record = ctx.symbolTable.getSymbol(targetSymbol);
  if (record.kind !== "type") {
    return;
  }
  ensureConstructorImport({
    targetSymbol,
    syntax: identifier,
    scope,
    ctx,
  });
};

const extractMemberName = (expr: Expr | undefined): string | undefined => {
  if (!expr) return undefined;
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    return expr.value;
  }
  if (!isForm(expr)) {
    return undefined;
  }
  const head = expr.at(0);
  if (isIdentifierAtom(head) || isInternalIdentifierAtom(head)) {
    return head.value;
  }
  return undefined;
};

const ensureModuleMemberImport = ({
  moduleId,
  moduleSymbol,
  memberName,
  syntax,
  scope,
  ctx,
}: {
  moduleId: string;
  moduleSymbol: number;
  memberName: string;
  syntax: Syntax;
  scope: ScopeId;
  ctx: BindingContext;
}): void => {
  const cached = ctx.moduleMembers.get(moduleSymbol)?.get(memberName)?.size;
  if (cached) {
    return;
  }
  const exportTable = ctx.moduleExports.get(moduleId);
  const exported = exportTable?.get(memberName);
  if (!exported) {
    ctx.diagnostics.push(
      diagnosticFromCode({
        code: "BD0001",
        params: { kind: "missing-export", moduleId, target: memberName },
        span: toSourceSpan(syntax),
      }),
    );
    return;
  }
  const locals = declareModuleMemberImport({
    exported,
    syntax,
    scope,
    ctx,
  });

  const memberMap =
    ctx.moduleMembers.get(moduleSymbol) ??
    createMemberBucket(ctx.moduleMembers, moduleSymbol);
  const members = memberMap.get(memberName) ?? new Set<number>();
  locals.forEach((symbol) => members.add(symbol));
  memberMap.set(memberName, members);
};

const createMemberBucket = (
  table: ModuleMemberTable,
  key: number,
): Map<string, Set<number>> => {
  const bucket = new Map<string, Set<number>>();
  table.set(key, bucket);
  return bucket;
};

const declareModuleMemberImport = ({
  exported,
  syntax,
  scope,
  ctx,
}: {
  exported: ModuleExportEntry;
  syntax: Syntax;
  scope: ScopeId;
  ctx: BindingContext;
}): number[] => {
  const symbols =
    exported.symbols && exported.symbols.length > 0
      ? exported.symbols
      : [exported.symbol];
  const locals: number[] = [];
  const dependency = ctx.dependencies.get(exported.moduleId);
  symbols.forEach((symbol) => {
    const dependencyRecord = dependency?.symbolTable.getSymbol(symbol);
    const importableMetadata = importableMetadataFrom(
      dependencyRecord?.metadata as Record<string, unknown> | undefined,
    );
    const importedModuleId =
      exported.kind === "module"
        ? (importedModuleIdFrom(
            dependencyRecord?.metadata as Record<string, unknown> | undefined,
          ) ?? exported.moduleId)
        : exported.moduleId;
    const local = ctx.symbolTable.declare(
      {
        name: exported.name,
        kind: exported.kind,
        declaredAt: syntax.syntaxId,
        metadata: {
          import:
            exported.kind === "module"
              ? { moduleId: importedModuleId }
              : { moduleId: exported.moduleId, symbol },
          ...(importableMetadata ?? {}),
        },
      },
      scope,
    );
    ctx.imports.push({
      name: exported.name,
      local,
      target:
        exported.kind === "module"
          ? undefined
          : { moduleId: exported.moduleId, symbol },
      visibility: moduleVisibility(),
      span: toSourceSpan(syntax),
    });
    locals.push(local);
  });

  if (locals.length > 1 && exported.overloadSet !== undefined) {
    const nextId = Math.max(-1, ...ctx.importedOverloadOptions.keys()) + 1;
    ctx.importedOverloadOptions.set(nextId, locals);
    locals.forEach((local) => ctx.overloadBySymbol.set(local, nextId));
  } else if (exported.overloadSet !== undefined && locals.length === 1) {
    ctx.overloadBySymbol.set(locals[0]!, exported.overloadSet);
  }

  return locals;
};

const declarePatternBindings = (
  pattern: Expr | undefined,
  ctx: BindingContext,
  scope: ScopeId,
  options: {
    mutable?: boolean;
    declarationSpan?: ReturnType<typeof toSourceSpan>;
  } = {},
): void => {
  if (!pattern) {
    throw new Error("missing pattern");
  }

  const { target: basePattern, bindingKind } = unwrapMutablePattern(pattern);

  if (isIdentifierAtom(basePattern)) {
    if (basePattern.value === "_") {
      return;
    }
    const declarationSpan =
      options.declarationSpan ?? toSourceSpan(basePattern);
    rememberSyntax(basePattern, ctx);
    declareValueOrParameter({
      name: basePattern.value,
      kind: "value",
      declaredAt: basePattern.syntaxId,
      metadata: {
        mutable: options.mutable ?? false,
        declarationSpan,
        bindingKind,
      },
      scope,
      syntax: basePattern,
      ctx,
    });
    return;
  }

  if (
    isForm(basePattern) &&
    (basePattern.calls("tuple") || basePattern.callsInternal("tuple"))
  ) {
    if (bindingKind && bindingKind !== "value") {
      throw new Error("mutable reference patterns must bind identifiers");
    }
    basePattern.rest.forEach((entry) =>
      declarePatternBindings(entry, ctx, scope, {
        mutable: options.mutable,
        declarationSpan: toSourceSpan(entry as Syntax),
      }),
    );
    return;
  }

  if (isForm(basePattern) && basePattern.callsInternal("object_literal")) {
    if (bindingKind && bindingKind !== "value") {
      throw new Error("mutable reference patterns must bind identifiers");
    }

    let seenSpread = false;
    basePattern.rest.forEach((entry) => {
      if (isIdentifierAtom(entry)) {
        declarePatternBindings(entry, ctx, scope, {
          mutable: options.mutable,
          declarationSpan: toSourceSpan(entry as Syntax),
        });
        return;
      }

      if (!isForm(entry)) {
        throw new Error("unsupported destructure entry in declaration");
      }

      if (entry.calls("...")) {
        if (seenSpread) {
          throw new Error("destructure pattern supports at most one spread");
        }
        seenSpread = true;
        declarePatternBindings(entry.at(1), ctx, scope, {
          mutable: options.mutable,
          declarationSpan: toSourceSpan(entry as Syntax),
        });
        return;
      }

      if (!entry.calls(":")) {
        throw new Error("unsupported destructure entry in declaration");
      }

      const valueExpr = entry.at(2);
      declarePatternBindings(valueExpr, ctx, scope, {
        mutable: options.mutable,
        declarationSpan: toSourceSpan(entry as Syntax),
      });
    });
    return;
  }

  if (isForm(basePattern) && basePattern.calls(":")) {
    const nameExpr = basePattern.at(1);
    const typeExpr = basePattern.at(2);
    const { target, bindingKind: nameBinding } = unwrapMutablePattern(nameExpr);
    rememberSyntax(typeExpr as Syntax, ctx);
    if (isIdentifierAtom(target)) {
      rememberSyntax(target as Syntax, ctx);
      declareValueOrParameter({
        name: target.value,
        kind: "value",
        declaredAt: basePattern.syntaxId,
        metadata: {
          mutable: options.mutable ?? false,
          declarationSpan: options.declarationSpan ?? toSourceSpan(basePattern),
          bindingKind: nameBinding ?? bindingKind,
        },
        scope,
        syntax: basePattern,
        ctx,
      });
      return;
    }
    declarePatternBindings(target, ctx, scope, {
      mutable: options.mutable,
      declarationSpan: options.declarationSpan ?? toSourceSpan(basePattern),
    });
    return;
  }

  throw new Error("unsupported pattern form in declaration");
};

const declareMatchPatternBindings = (
  pattern: Expr | undefined,
  ctx: BindingContext,
  scope: ScopeId,
): void => {
  if (!pattern) {
    throw new Error("match case missing pattern");
  }

  if (isIdentifierAtom(pattern)) {
    return;
  }

  if (!isForm(pattern)) {
    return;
  }

  if (pattern.calls("as")) {
    const bindingPattern = pattern.at(2);
    declarePatternBindings(bindingPattern, ctx, scope, {
      mutable: false,
      declarationSpan: toSourceSpan(pattern as unknown as Syntax),
    });
    return;
  }

  if (pattern.calls("tuple") || pattern.callsInternal("tuple")) {
    declarePatternBindings(pattern, ctx, scope, {
      mutable: false,
      declarationSpan: toSourceSpan(pattern as unknown as Syntax),
    });
    return;
  }

  const last = pattern.at(-1);
  if (isForm(last) && last.callsInternal("object_literal")) {
    declarePatternBindings(last, ctx, scope, {
      mutable: false,
      declarationSpan: toSourceSpan(last as unknown as Syntax),
    });
  }
};

const unwrapMutablePattern = (
  pattern: Expr | undefined,
): { target: Expr; bindingKind?: HirBindingKind } => {
  if (!pattern) {
    throw new Error("missing pattern");
  }

  if (isForm(pattern) && pattern.calls("~")) {
    const target = pattern.at(1);
    if (!target) {
      throw new Error("mutable pattern is missing a target");
    }
    return { target, bindingKind: "mutable-ref" };
  }

  return { target: pattern, bindingKind: undefined };
};
