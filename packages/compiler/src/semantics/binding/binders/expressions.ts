import {
  type Expr,
  type IdentifierAtom,
  type Form,
  type Syntax,
  type InternalIdentifierAtom,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../../../parser/index.js";
import {
  parseIfBranches,
  parseWhileConditionAndBody,
  toSourceSpan,
} from "../../../parser/surface/utils.js";
import { diagnosticFromCode } from "../../../diagnostics/index.js";
import { rememberSyntax } from "../context.js";
import { declareValueOrParameter } from "../redefinitions.js";
import type { BindingContext, BindingResult } from "../types.js";
import type { ScopeId, SymbolId } from "../../ids.js";
import type { BinderScopeTracker } from "./scope-tracker.js";
import { moduleVisibility } from "../../hir/index.js";
import type { ModuleExportEntry } from "../../modules.js";
import type { ModuleMemberTable } from "../types.js";
import { extractConstructorTargetIdentifier } from "../../constructors.js";
import {
  parseSurfaceBindingStatement,
  parseSurfaceHandlerClause,
  parseSurfaceLambdaExpression,
  parseSurfaceMatchExpression,
  parseSurfaceTryExpression,
  type SurfaceHandlerHead,
  type SurfaceMatchPattern,
  type SurfacePattern,
} from "../../../parser/surface/index.js";
import {
  importableMetadataFrom,
  importedModuleExplicitStdSubmoduleFrom,
  importedModuleIdFrom,
} from "../../imports/metadata.js";
import {
  canAccessExport,
  canAccessSymbolVisibility,
} from "../export-visibility.js";
import {
  enumVariantTypeNamesFromAliasTarget,
  importedSymbolTargetFromMetadata,
} from "../../enum-namespace.js";
import {
  ARRAY_LITERAL_CONSTRUCTOR_EXPORT,
  ARRAY_LITERAL_CONSTRUCTOR_MODULE_ID,
  GENERATED_ARRAY_LITERAL_HELPER,
  GENERATED_STRING_LITERAL_HELPER,
  STRING_LITERAL_CONSTRUCTOR_EXPORT,
  STRING_LITERAL_CONSTRUCTOR_MODULE_ID,
} from "../../generated-syntax-helpers.js";
import {
  collectTryHandlerClauses,
  isTryHandlerClause,
} from "../../try-handler-clauses.js";

export const bindExpr = (
  expr: Expr | undefined,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  if (!expr || !isForm(expr)) return;

  if (expr.callsInternal("new_string")) {
    ensureGeneratedStringLiteralImport({
      syntax: expr,
      scope: tracker.current(),
      ctx,
    });
  }

  if (expr.callsInternal("new_array_unchecked")) {
    ensureGeneratedArrayLiteralImport({
      syntax: expr,
      scope: tracker.current(),
      ctx,
    });
  }

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

export const bindTypeExpr = (
  expr: Expr | undefined,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  if (!expr || !isForm(expr)) return;

  if (expr.calls("::")) {
    bindTypeNamespaceAccess(expr, ctx, tracker);
    return;
  }

  for (const child of expr.toArray()) {
    bindTypeExpr(child, ctx, tracker);
  }
};

const bindTry = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  const handlerEntries: Form[] = [];
  const { body, bodyIndex } = parseSurfaceTryExpression(form);
  if (isForm(body) && body.calls("block")) {
    body.rest.forEach((entry) => {
      if (
        isTryHandlerClause({
          expr: entry,
          scope: tracker.current(),
          resolveBareHandlerHead: ({ name, scope }) =>
            typeof ctx.symbolTable.resolveByKinds(name, scope, [
              "effect-op",
            ]) === "number",
        }) &&
        isForm(entry)
      ) {
        handlerEntries.push(entry);
      }
    });
  }
  handlerEntries.push(
    ...collectTryHandlerClauses({
      expr: body,
      scope: tracker.current(),
      resolveBareHandlerHead: ({ name, scope }) =>
        typeof ctx.symbolTable.resolveByKinds(name, scope, ["effect-op"]) ===
        "number",
    }),
  );
  bindExpr(body, ctx, tracker);

  handlerEntries.push(
    ...form.rest
      .slice(bodyIndex)
      .filter((entry): entry is Form => isForm(entry)),
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

    const { head, body: handlerBody } = parseSurfaceHandlerClause(entry);

    tracker.enterScope(clauseScope, () => {
      // Handler heads can reference imported operations (for example `Fx::op`).
      // Bind the head itself so namespace member imports are materialized before
      // lowering resolves handler operation symbols.
      bindExpr(head.syntax, ctx, tracker);
      declareHandlerParams(head, ctx, clauseScope);
      bindExpr(handlerBody, ctx, tracker);
    });
  });
};

const declareHandlerParams = (
  head: SurfaceHandlerHead,
  ctx: BindingContext,
  scope: number,
): void => {
  head.parameters.forEach(({ syntax: nameExpr }) => {
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
  const match = parseSurfaceMatchExpression(form);

  const matchScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "block",
    owner: form.syntaxId,
  });
  ctx.scopeByNode.set(form.syntaxId, matchScope);

  tracker.enterScope(matchScope, () => {
    bindExpr(match.operand, ctx, tracker);

    if (match.binder) {
      rememberSyntax(match.binder, ctx);
      declareValueOrParameter({
        name: match.binder.value,
        kind: "value",
        declaredAt: match.binder.syntaxId,
        metadata: {
          declarationSpan: toSourceSpan(match.binder),
        },
        scope: matchScope,
        syntax: match.binder,
        ctx,
      });
    }

    match.arms.forEach((arm) => {
      const caseScope = ctx.symbolTable.createScope({
        parent: matchScope,
        kind: "block",
        owner: arm.form.syntaxId,
      });
      ctx.scopeByNode.set(arm.form.syntaxId, caseScope);

      tracker.enterScope(caseScope, () => {
        declareMatchPatternBindings(arm.pattern, ctx, caseScope);
        bindExpr(arm.value, ctx, tracker);
      });
    });
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
  const binding = parseSurfaceBindingStatement(form);
  declareSurfacePatternBindings(binding.pattern, ctx, tracker.current(), {
    mutable: binding.kind === "var",
    declarationSpan: toSourceSpan(binding.patternExpr as Syntax),
  });
  bindExpr(binding.initializer, ctx, tracker);
};

const bindLambda = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  const {
    signatureExpr,
    signature,
    body: bodyExpr,
  } = parseSurfaceLambdaExpression(form);

  rememberSyntax(form, ctx);
  rememberSyntax(signatureExpr as Syntax, ctx);
  rememberSyntax(bodyExpr as Syntax, ctx);

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

    signature.normalizedParameters.forEach((param) =>
      declareLambdaParam(param, scope, ctx),
    );
    signature.normalizedParameters.forEach((param) =>
      bindTypeExpr(param.typeExpr, ctx, tracker),
    );
    bindTypeExpr(signature.returnType, ctx, tracker);
    bindTypeExpr(signature.effectType, ctx, tracker);
    bindExpr(bodyExpr, ctx, tracker);
  });
};

const declareLambdaParam = (
  param: import("../../../parser/surface/index.js").SurfaceLambdaParameter,
  scope: ScopeId,
  ctx: BindingContext,
): void => {
  const declarationSpan = toSourceSpan(param.syntax);
  rememberSyntax(param.syntax, ctx);
  rememberSyntax(param.name, ctx);
  rememberSyntax(param.typeExpr as Syntax, ctx);
  declareValueOrParameter({
    name: param.name.value,
    kind: "parameter",
    declaredAt: param.syntax.syntaxId,
    metadata: { bindingKind: param.bindingKind, declarationSpan },
    scope,
    syntax: param.syntax,
    ctx,
  });
};

const maybeBindConstructorCall = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  if (form.length < 1) {
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
  bindNamespaceAccessCore({
    form,
    ctx,
    scope: tracker.current(),
    bindChild: (expr) => bindExpr(expr, ctx, tracker),
  });
};

const bindTypeNamespaceAccess = (
  form: Form,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  bindNamespaceAccessCore({
    form,
    ctx,
    scope: tracker.current(),
    bindChild: (expr) => bindTypeExpr(expr, ctx, tracker),
  });
};

const bindNamespaceAccessCore = ({
  form,
  ctx,
  scope,
  bindChild,
}: {
  form: Form;
  ctx: BindingContext;
  scope: ScopeId;
  bindChild: (expr: Expr | undefined) => void;
}): void => {
  const target = form.at(1);
  const member = form.at(2);

  bindChild(target);
  bindChild(member);

  const memberName = extractMemberName(member);
  if (!memberName) {
    return;
  }

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

type ImportMeta = {
  import?: {
    moduleId?: string;
    symbol?: number;
    explicitlyTargetsStdSubmodule?: boolean;
  };
};

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
  const explicitlyTargetsStdSubmodule =
    importMeta?.import?.explicitlyTargetsStdSubmodule === true;
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
    existing.forEach((symbol) =>
      ensureConstructorImport({
        targetSymbol: symbol,
        syntax,
        scope,
        ctx,
      }),
    );
    return;
  }

  const imported: {
    importLocal: SymbolId;
    staticLocal: SymbolId;
    overloadId?: number;
  }[] = [];
  methodSymbols.forEach((methodSymbol) => {
    const syntheticAliasConstructorTarget =
      resolveSyntheticAliasConstructorImportTarget({
        methodSymbol,
        dependency,
      });
    const importTargetSymbol = syntheticAliasConstructorTarget ?? methodSymbol;
    const visibilityAllowed = canImportStaticMethodSymbol({
      importTargetSymbol,
      moduleId,
      dependency,
      explicitlyTargetsStdSubmodule,
      allowSyntheticAliasConstructorFallback:
        memberName === "init" &&
        typeof syntheticAliasConstructorTarget === "number",
      ctx,
    });
    if (!visibilityAllowed) {
      return;
    }
    const record = dependency.symbolTable.getSymbol(importTargetSymbol);
    const local = ctx.symbolTable.declare(
      {
        name: memberName,
        kind: record.kind,
        declaredAt: syntax.syntaxId,
        metadata: { import: { moduleId, symbol: importTargetSymbol } },
      },
      scope,
    );
    ctx.imports.push({
      name: memberName,
      local,
      target: { moduleId, symbol: importTargetSymbol },
      visibility: moduleVisibility(),
      span: toSourceSpan(syntax),
    });
    const overloadId =
      typeof syntheticAliasConstructorTarget === "number"
        ? undefined
        : (dependency.overloadBySymbol.get(methodSymbol) ??
          dependency.overloadBySymbol.get(importTargetSymbol));
    const aliasAwareLocal =
      typeof syntheticAliasConstructorTarget === "number"
        ? declareAliasAwareImportedStaticMethod({
            name: memberName,
            declaredAt: syntax.syntaxId,
            scope,
            aliasSymbol: targetSymbol,
            constructorSymbol: local,
            ctx,
          })
        : local;
    imported.push({
      importLocal: local,
      staticLocal: aliasAwareLocal,
      overloadId,
    });
  });

  if (imported.length === 0) {
    return;
  }

  const staticLocals = imported.map((entry) => entry.staticLocal);
  const bucket = ctx.staticMethods.get(targetSymbol) ?? new Map();
  bucket.set(memberName, new Set(staticLocals));
  ctx.staticMethods.set(targetSymbol, bucket);

  const importedOverloadIds = new Set(
    imported
      .map((entry) => entry.overloadId)
      .filter((entry): entry is number => typeof entry === "number"),
  );
  const needsImportedSet =
    staticLocals.length > 1 || importedOverloadIds.size === 1;
  if (needsImportedSet) {
    const nextId =
      Math.max(
        -1,
        ...ctx.importedOverloadOptions.keys(),
        ...ctx.overloads.keys(),
      ) + 1;
    const setId = importedOverloadIds.size === 1 ? nextId : nextId;
    const existing = ctx.importedOverloadOptions.get(setId);
    const overloadLocals = imported.map((entry) => entry.importLocal);
    const merged = existing
      ? Array.from(new Set([...existing, ...overloadLocals]))
      : overloadLocals;
    ctx.importedOverloadOptions.set(setId, merged);
    merged.forEach((local) => ctx.overloadBySymbol.set(local, setId));
    staticLocals.forEach((local) => ctx.overloadBySymbol.set(local, setId));
  }
};

const canImportStaticMethodSymbol = ({
  importTargetSymbol,
  moduleId,
  dependency,
  explicitlyTargetsStdSubmodule,
  allowSyntheticAliasConstructorFallback,
  ctx,
}: {
  importTargetSymbol: SymbolId;
  moduleId: string;
  dependency: BindingResult;
  explicitlyTargetsStdSubmodule: boolean;
  allowSyntheticAliasConstructorFallback: boolean;
  ctx: BindingContext;
}): boolean => {
  const fn = dependency.functions.find(
    (entry) => entry.symbol === importTargetSymbol,
  );
  if (fn) {
    return canAccessSymbolVisibility({
      visibility: fn.visibility,
      ownerPackageId: dependency.packageId,
      importedFromModuleId: moduleId,
      explicitlyTargetsStdSubmodule,
      allowApiVisibility: true,
      ctx,
    });
  }

  const exported = findExportedSymbolInModule({
    moduleId,
    symbol: importTargetSymbol,
    ctx,
  });
  if (!exported && allowSyntheticAliasConstructorFallback) {
    // Synthetic alias constructor wrappers can ultimately target imported
    // symbols that are not listed in dependency.functions or module exports.
    // In that case, rely on alias-namespace reachability that produced the
    // static method entry rather than dropping valid constructors.
    return true;
  }
  if (!exported) {
    return false;
  }

  return canAccessExport({
    exported,
    moduleId,
    explicitlyTargetsStdSubmodule,
    ctx,
  });
};

const findExportedSymbolInModule = ({
  moduleId,
  symbol,
  ctx,
}: {
  moduleId: string;
  symbol: SymbolId;
  ctx: BindingContext;
}): ModuleExportEntry | undefined => {
  const exportTable = ctx.moduleExports.get(moduleId);
  if (!exportTable) {
    return undefined;
  }
  return Array.from(exportTable.values()).find(
    (entry) =>
      entry.symbol === symbol ||
      entry.symbols?.some((candidate) => candidate === symbol),
  );
};

const declareAliasAwareImportedStaticMethod = ({
  name,
  declaredAt,
  scope,
  aliasSymbol,
  constructorSymbol,
  ctx,
}: {
  name: string;
  declaredAt: number;
  scope: ScopeId;
  aliasSymbol: SymbolId;
  constructorSymbol: SymbolId;
  ctx: BindingContext;
}): SymbolId => {
  const aliasRecord = ctx.symbolTable.getSymbol(aliasSymbol);
  const aliasMetadata = aliasRecord.metadata as
    | {
        nominalTargetTypeArguments?: unknown;
        nominalTargetTypeParameterNames?: unknown;
      }
    | undefined;
  return ctx.symbolTable.declare(
    {
      name,
      kind: "value",
      declaredAt,
      metadata: {
        aliasConstructorTarget: constructorSymbol,
        aliasConstructorAlias: aliasSymbol,
        nominalTargetTypeArguments: aliasMetadata?.nominalTargetTypeArguments,
        nominalTargetTypeParameterNames:
          aliasMetadata?.nominalTargetTypeParameterNames,
      },
    },
    scope,
  );
};

const resolveSyntheticAliasConstructorImportTarget = ({
  methodSymbol,
  dependency,
}: {
  methodSymbol: SymbolId;
  dependency: BindingResult;
}): SymbolId | undefined => {
  let current = methodSymbol;
  let resolved = false;
  const visited = new Set<SymbolId>();

  while (!visited.has(current)) {
    visited.add(current);
    const methodRecord = dependency.symbolTable.getSymbol(current);
    const metadata = methodRecord.metadata as
      | { aliasConstructorTarget?: unknown }
      | undefined;
    if (typeof metadata?.aliasConstructorTarget !== "number") {
      return resolved ? current : undefined;
    }
    current = metadata.aliasConstructorTarget;
    resolved = true;
  }

  return resolved ? current : undefined;
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
  const explicitlyTargetsStdSubmodule =
    importedModuleExplicitStdSubmoduleFrom(
      targetRecord.metadata as Record<string, unknown> | undefined,
    ) ?? false;
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
    ctx.diagnostics.push(
      diagnosticFromCode({
        code: "BD0001",
        params: {
          kind: "missing-export",
          moduleId: importedTarget.moduleId,
          target: memberName,
        },
        span: toSourceSpan(syntax),
      }),
    );
    return;
  }
  if (
    !canAccessExport({
      exported,
      moduleId: importedTarget.moduleId,
      ctx,
      explicitlyTargetsStdSubmodule,
    })
  ) {
    ctx.diagnostics.push(
      diagnosticFromCode({
        code: "BD0001",
        params: {
          kind: "out-of-scope-export",
          moduleId: importedTarget.moduleId,
          target: memberName,
          visibility: exported.visibility.level,
        },
        span: toSourceSpan(syntax),
      }),
    );
    return;
  }

  const exportedRecord = dependency.symbolTable.getSymbol(exported.symbol);
  const metadata = exportedRecord.metadata as { entity?: string } | undefined;
  if (exportedRecord.kind !== "type" || metadata?.entity !== "object") {
    return;
  }

  const locals = declareModuleMemberImport({
    exported,
    explicitlyTargetsStdSubmodule,
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
  locals.forEach((local) =>
    ensureConstructorImport({
      targetSymbol: local,
      syntax,
      scope,
      ctx,
    }),
  );
};

export const ensureConstructorImport = ({
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

export const ensureModuleMemberImport = ({
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
  const moduleRecord = ctx.symbolTable.getSymbol(moduleSymbol);
  const explicitlyTargetsStdSubmodule =
    importedModuleExplicitStdSubmoduleFrom(
      moduleRecord.metadata as Record<string, unknown> | undefined,
    ) ?? false;
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
    explicitlyTargetsStdSubmodule,
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

const ensureGeneratedStringLiteralImport = ({
  syntax,
  scope,
  ctx,
}: {
  syntax: Syntax;
  scope: ScopeId;
  ctx: BindingContext;
}): void => {
  if (
    typeof ctx.symbolTable.resolve(GENERATED_STRING_LITERAL_HELPER, scope) ===
    "number"
  ) {
    return;
  }

  const exportTable = ctx.moduleExports.get(
    STRING_LITERAL_CONSTRUCTOR_MODULE_ID,
  );
  const exported = exportTable?.get(STRING_LITERAL_CONSTRUCTOR_EXPORT);
  if (!exported || exported.kind === "module") {
    return;
  }

  const dependency = ctx.dependencies.get(exported.moduleId);
  if (!dependency) {
    return;
  }

  const sourceMetadata = dependency.symbolTable.getSymbol(
    exported.symbol,
  ).metadata;
  const importableMetadata = importableMetadataFrom(
    sourceMetadata as Record<string, unknown> | undefined,
  );
  const importedSymbolTarget = importedSymbolTargetFromMetadata(
    sourceMetadata as Record<string, unknown> | undefined,
  );
  const importedModuleId = importedSymbolTarget?.moduleId ?? exported.moduleId;
  const importedSymbolId = importedSymbolTarget?.symbol ?? exported.symbol;
  const local = ctx.symbolTable.declare({
    name: GENERATED_STRING_LITERAL_HELPER,
    kind: exported.kind,
    declaredAt: syntax.syntaxId,
    metadata: {
      import: {
        moduleId: importedModuleId,
        symbol: importedSymbolId,
        explicitlyTargetsStdSubmodule: true,
      },
      implicitCompilerImport: true,
      ...(importableMetadata ?? {}),
    },
  });

  ctx.imports.push({
    name: GENERATED_STRING_LITERAL_HELPER,
    local,
    target: {
      moduleId: importedModuleId,
      symbol: importedSymbolId,
    },
    visibility: moduleVisibility(),
    span: toSourceSpan(syntax),
  });
};

const ensureGeneratedArrayLiteralImport = ({
  syntax,
  scope,
  ctx,
}: {
  syntax: Syntax;
  scope: ScopeId;
  ctx: BindingContext;
}): void => {
  if (
    typeof ctx.symbolTable.resolve(GENERATED_ARRAY_LITERAL_HELPER, scope) ===
    "number"
  ) {
    return;
  }

  const exportTable = ctx.moduleExports.get(
    ARRAY_LITERAL_CONSTRUCTOR_MODULE_ID,
  );
  const exported = exportTable?.get(ARRAY_LITERAL_CONSTRUCTOR_EXPORT);
  if (!exported || exported.kind === "module") {
    return;
  }

  const dependency = ctx.dependencies.get(exported.moduleId);
  if (!dependency) {
    return;
  }

  const sourceMetadata = dependency.symbolTable.getSymbol(
    exported.symbol,
  ).metadata;
  const importableMetadata = importableMetadataFrom(
    sourceMetadata as Record<string, unknown> | undefined,
  );
  const importedSymbolTarget = importedSymbolTargetFromMetadata(
    sourceMetadata as Record<string, unknown> | undefined,
  );
  const importedModuleId = importedSymbolTarget?.moduleId ?? exported.moduleId;
  const importedSymbolId = importedSymbolTarget?.symbol ?? exported.symbol;
  const local = ctx.symbolTable.declare({
    name: GENERATED_ARRAY_LITERAL_HELPER,
    kind: exported.kind,
    declaredAt: syntax.syntaxId,
    metadata: {
      import: {
        moduleId: importedModuleId,
        symbol: importedSymbolId,
        explicitlyTargetsStdSubmodule: true,
      },
      implicitCompilerImport: true,
      ...(importableMetadata ?? {}),
    },
  });

  ctx.imports.push({
    name: GENERATED_ARRAY_LITERAL_HELPER,
    local,
    target: {
      moduleId: importedModuleId,
      symbol: importedSymbolId,
    },
    visibility: moduleVisibility(),
    span: toSourceSpan(syntax),
  });
};

const declareModuleMemberImport = ({
  exported,
  explicitlyTargetsStdSubmodule = false,
  syntax,
  scope,
  ctx,
}: {
  exported: ModuleExportEntry;
  explicitlyTargetsStdSubmodule?: boolean;
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
              ? {
                  moduleId: importedModuleId,
                  explicitlyTargetsStdSubmodule,
                }
              : {
                  moduleId: exported.moduleId,
                  symbol,
                  explicitlyTargetsStdSubmodule,
                },
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

const declareSurfacePatternBindings = (
  pattern: SurfacePattern,
  ctx: BindingContext,
  scope: ScopeId,
  options: {
    mutable?: boolean;
    declarationSpan?: ReturnType<typeof toSourceSpan>;
    declarationSyntax?: Syntax;
  },
): void => {
  if (pattern.kind === "identifier") {
    if (pattern.name.value === "_") {
      return;
    }
    const declarationSpan =
      options.declarationSpan ?? toSourceSpan(pattern.syntax);
    rememberSyntax(pattern.syntax, ctx);
    rememberSyntax(pattern.name, ctx);
    declareValueOrParameter({
      name: pattern.name.value,
      kind: "value",
      declaredAt:
        options.declarationSyntax?.syntaxId ?? pattern.syntax.syntaxId,
      metadata: {
        mutable: options.mutable ?? false,
        declarationSpan,
        bindingKind: pattern.bindingKind,
      },
      scope,
      syntax: options.declarationSyntax ?? pattern.syntax,
      ctx,
    });
    return;
  }
  if (pattern.kind === "tuple") {
    pattern.elements.forEach((entry) =>
      declareSurfacePatternBindings(entry, ctx, scope, {
        mutable: options.mutable,
        declarationSpan: toSourceSpan(entry.syntax),
      }),
    );
    return;
  }
  if (pattern.kind === "destructure") {
    pattern.fields.forEach((field) =>
      declareSurfacePatternBindings(field.pattern, ctx, scope, {
        mutable: options.mutable,
        declarationSpan: toSourceSpan(field.pattern.syntax),
      }),
    );
    if (pattern.spread) {
      declareSurfacePatternBindings(pattern.spread, ctx, scope, {
        mutable: options.mutable,
        declarationSpan: toSourceSpan(pattern.spread.syntax),
      });
    }
    return;
  }
  if (pattern.kind === "typed") {
    rememberSyntax(pattern.typeExpr as Syntax, ctx);
    declareSurfacePatternBindings(pattern.pattern, ctx, scope, {
      mutable: options.mutable,
      declarationSpan: options.declarationSpan ?? toSourceSpan(pattern.syntax),
      declarationSyntax: pattern.syntax,
    });
  }
};

const declareMatchPatternBindings = (
  pattern: SurfaceMatchPattern,
  ctx: BindingContext,
  scope: ScopeId,
): void => {
  if (pattern.kind === "type-binding") {
    declareSurfacePatternBindings(pattern.binding, ctx, scope, {
      mutable: false,
      declarationSpan: toSourceSpan(pattern.syntax),
    });
    return;
  }
  if (pattern.kind === "tuple") {
    declareSurfacePatternBindings(pattern.binding, ctx, scope, {
      mutable: false,
      declarationSpan: toSourceSpan(pattern.syntax),
    });
    return;
  }
  if (pattern.kind === "destructure") {
    declareSurfacePatternBindings(pattern.binding, ctx, scope, {
      mutable: false,
      declarationSpan: toSourceSpan(pattern.binding.syntax),
    });
  }
};
