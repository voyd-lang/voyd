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
  identifierBindingKey,
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
import {
  firstInstanceMemberOwner,
  moduleNamespaceExportEntry,
  type ModuleExportEntry,
} from "../../modules.js";
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
import { isPackageRootModule } from "../../packages.js";
import {
  enumVariantTypeTargetsFromAliasTarget,
  importedSymbolTargetFromMetadata,
} from "../../enum-namespace.js";
import { resolveNominalTypeSymbol } from "../../nominal-type-target.js";
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
import {
  resolveQualifiedEffectOperation,
  resolveUnqualifiedEffectOperation,
} from "../../effect-operation-resolution.js";
import { bindingIdentityForSyntax } from "../hygiene.js";

export const bindExpr = (
  expr: Expr | undefined,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => bindExprAtPosition(expr, ctx, tracker, "value");

export const flushPendingHandlerOperationBindings = (
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  const pending = ctx.pendingHandlerOperationBindings;
  ctx.pendingHandlerOperationBindings = [];
  pending.forEach(({ head, scope }) => {
    tracker.enterScope(scope, () => {
      bindExpr(head.syntax, ctx, tracker);
      validateHandlerOperationBinding({
        head,
        ctx,
        scope,
        deferUnresolvedQualifier: false,
      });
    });
  });
};

const bindExprAtPosition = (
  expr: Expr | undefined,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
  position: "value" | "callee",
): void => {
  if (!expr) return;
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    bindHygienicIdentifierReference(expr, ctx, tracker.current());
    if (position === "value") {
      reportFirstClassEffectOperationReference({
        identifier: expr,
        ctx,
        scope: tracker.current(),
      });
    }
    return;
  }
  if (!isForm(expr)) return;

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

  const [callee, ...args] = expr.toArray();
  bindExprAtPosition(callee, ctx, tracker, "callee");
  const argPosition =
    position === "callee" && expr.callsInternal("generics")
      ? "callee"
      : "value";
  for (const arg of args) {
    bindExprAtPosition(arg, ctx, tracker, argPosition);
  }
};

const reportFirstClassEffectOperationReference = ({
  identifier,
  ctx,
  scope,
}: {
  identifier: IdentifierAtom | InternalIdentifierAtom;
  ctx: BindingContext;
  scope: ScopeId;
}): void => {
  const symbol = resolveUnqualifiedEffectOperation({
    name: identifier.value,
    scope,
    symbolTable: ctx.symbolTable,
    bindingIdentity: identifierBindingKey(identifier),
    directSymbol: ctx.directSymbolBySyntax.get(identifier.syntaxId),
  });
  if (typeof symbol !== "number") {
    return;
  }

  const local = ctx.decls.getEffectOperation(symbol);
  const importedTarget = local
    ? undefined
    : importedSymbolTargetFromMetadata(
        ctx.symbolTable.getSymbol(symbol).metadata as
          | Record<string, unknown>
          | undefined,
      );
  const operation =
    local ??
    (importedTarget
      ? ctx.dependencies
          .get(importedTarget.moduleId)
          ?.decls.getEffectOperation(importedTarget.symbol)
      : undefined);
  const record = ctx.symbolTable.getSymbol(symbol);

  ctx.diagnostics.push(
    diagnosticFromCode({
      code: "BD0009",
      params: {
        kind: "first-class-effect-operation",
        effectName: operation?.effect.name ?? "effect",
        operationName: operation?.operation.name ?? record.name,
      },
      span: toSourceSpan(identifier),
    }),
  );
};

export const bindTypeExpr = (
  expr: Expr | undefined,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  if (!expr) return;
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    bindHygienicIdentifierReference(expr, ctx, tracker.current());
    return;
  }
  if (!isForm(expr)) return;

  if (expr.calls("::")) {
    bindTypeNamespaceAccess(expr, ctx, tracker);
    return;
  }

  for (const child of expr.toArray()) {
    bindTypeExpr(child, ctx, tracker);
  }
};

const bindHygienicIdentifierReference = (
  identifier: IdentifierAtom | InternalIdentifierAtom,
  ctx: BindingContext,
  scope: ScopeId,
): void => {
  const lexicalContext = identifier.lexicalContext;
  const bindingIdentity = identifierBindingKey(identifier);
  if (!lexicalContext || !bindingIdentity || lexicalContext.kind === "fresh") {
    return;
  }

  const existing = ctx.symbolTable.resolveBinding(
    identifier.value,
    bindingIdentity,
    scope,
  );
  if (typeof existing === "number") {
    ctx.directSymbolBySyntax.set(identifier.syntaxId, existing);
    return;
  }

  const targetModuleId =
    lexicalContext.kind === "macro-template"
      ? lexicalContext.definitionModuleId
      : lexicalContext.targetModuleId;
  const isCurrentModule = targetModuleId === ctx.module.id;
  if (isCurrentModule) {
    const exact = ctx.symbolTable.resolveAllBindings(
      identifier.value,
      bindingIdentity,
      ctx.symbolTable.rootScope,
    );
    const targets =
      exact.length > 0
        ? exact
        : ctx.symbolTable.resolveAll(
            identifier.value,
            ctx.symbolTable.rootScope,
          );
    if (targets.length === 0) {
      return;
    }
    targets.forEach((symbol) =>
      ctx.symbolTable.bindAlias(
        { name: identifier.value, symbol, bindingIdentity },
        ctx.symbolTable.rootScope,
      ),
    );
    ctx.directSymbolBySyntax.set(identifier.syntaxId, targets[0]!);
    return;
  }

  const cacheKey = `${targetModuleId}:${identifier.value}:${bindingIdentity}`;
  const cached = ctx.hygienicImportCache.get(cacheKey);
  if (cached !== undefined) {
    if (cached.length > 0) {
      ctx.directSymbolBySyntax.set(identifier.syntaxId, cached[0]!);
    }
    return;
  }

  const dependency = ctx.dependencies.get(targetModuleId);
  if (!dependency) {
    ctx.hygienicImportCache.set(cacheKey, []);
    reportUnresolvedSymbolReference({ identifier, targetModuleId, ctx });
    return;
  }
  const targetSymbols = (() => {
    if (
      lexicalContext.kind === "symbol-reference" &&
      lexicalContext.compilerOwned
    ) {
      const exported = ctx.moduleExports
        .get(targetModuleId)
        ?.get(identifier.value);
      if (!exported || exported.kind === "module") {
        return [];
      }
      return exported.symbols?.length
        ? [...exported.symbols]
        : [exported.symbol];
    }
    const exact = dependency.symbolTable.resolveAllBindings(
      identifier.value,
      bindingIdentity,
      dependency.symbolTable.rootScope,
    );
    return exact.length > 0
      ? [...exact]
      : [
          ...dependency.symbolTable.resolveAll(
            identifier.value,
            dependency.symbolTable.rootScope,
          ),
        ];
  })();
  if (targetSymbols.length === 0) {
    ctx.hygienicImportCache.set(cacheKey, []);
    reportUnresolvedSymbolReference({ identifier, targetModuleId, ctx });
    return;
  }

  const locals = targetSymbols.map((targetSymbol) => {
    const target = resolveHygienicImportTarget({
      moduleId: targetModuleId,
      symbol: targetSymbol,
      ctx,
    });
    const targetRecord = target.dependency.symbolTable.getSymbol(target.symbol);
    const referencedModuleId = importedModuleIdFrom(
      targetRecord.metadata as Record<string, unknown> | undefined,
    );
    const importableMetadata = importableMetadataFrom(
      targetRecord.metadata as Record<string, unknown> | undefined,
    );
    const local = ctx.symbolTable.declare(
      {
        name: identifier.value,
        kind: targetRecord.kind,
        declaredAt: identifier.syntaxId,
        bindingIdentity,
        metadata: {
          import:
            targetRecord.kind === "module" && referencedModuleId
              ? { moduleId: referencedModuleId }
              : { moduleId: target.moduleId, symbol: target.symbol },
          hygienicReference: true,
          ...(importableMetadata ?? {}),
        },
      },
      ctx.symbolTable.rootScope,
    );
    ctx.imports.push({
      name: identifier.value,
      local,
      target: { moduleId: target.moduleId, symbol: target.symbol },
      visibility: moduleVisibility(),
      span: toSourceSpan(identifier),
    });
    return local;
  });

  const dependencyOverloadSets = new Set(
    targetSymbols.flatMap((symbol) => {
      const set = dependency.overloadBySymbol.get(symbol);
      return typeof set === "number" ? [set] : [];
    }),
  );
  if (locals.length > 1 || dependencyOverloadSets.size > 0) {
    const nextId =
      Math.max(
        -1,
        ...ctx.importedOverloadOptions.keys(),
        ...ctx.overloads.keys(),
      ) + 1;
    ctx.importedOverloadOptions.set(nextId, locals);
    locals.forEach((local) => ctx.overloadBySymbol.set(local, nextId));
  }

  ctx.hygienicImportCache.set(cacheKey, locals);
  ctx.directSymbolBySyntax.set(identifier.syntaxId, locals[0]!);
};

const resolveHygienicImportTarget = ({
  moduleId,
  symbol,
  ctx,
}: {
  moduleId: string;
  symbol: SymbolId;
  ctx: BindingContext;
}): {
  moduleId: string;
  symbol: SymbolId;
  dependency: BindingResult;
} => {
  const seen = new Set<string>();
  let currentModuleId = moduleId;
  let currentSymbol = symbol;
  let dependency = ctx.dependencies.get(currentModuleId)!;

  while (true) {
    const key = `${currentModuleId}:${currentSymbol}`;
    if (seen.has(key)) {
      return { moduleId: currentModuleId, symbol: currentSymbol, dependency };
    }
    seen.add(key);

    const record = dependency.symbolTable.getSymbol(currentSymbol);
    const imported = importedSymbolTargetFromMetadata(
      record.metadata as Record<string, unknown> | undefined,
    );
    if (!imported) {
      return { moduleId: currentModuleId, symbol: currentSymbol, dependency };
    }
    const importedDependency = ctx.dependencies.get(imported.moduleId);
    if (!importedDependency) {
      return { moduleId: currentModuleId, symbol: currentSymbol, dependency };
    }
    currentModuleId = imported.moduleId;
    currentSymbol = imported.symbol;
    dependency = importedDependency;
  }
};

const reportUnresolvedSymbolReference = ({
  identifier,
  targetModuleId,
  ctx,
}: {
  identifier: IdentifierAtom | InternalIdentifierAtom;
  targetModuleId: string;
  ctx: BindingContext;
}): void => {
  if (identifier.lexicalContext?.kind !== "symbol-reference") {
    return;
  }
  const definition = identifier.macroProvenance?.definition;
  const related = definition
    ? [
        diagnosticFromCode({
          code: "BD0008",
          params: { kind: "macro-definition-reference" },
          severity: "note",
          span: {
            file: definition.filePath,
            start: definition.startIndex,
            end: definition.endIndex,
          },
        }),
      ]
    : undefined;
  ctx.diagnostics.push(
    diagnosticFromCode({
      code: "BD0008",
      params: {
        kind: "unresolved-symbol-reference",
        name: identifier.value,
        moduleId: targetModuleId,
      },
      span: toSourceSpan(identifier),
      related,
    }),
  );
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
          resolveBareHandlerHead: ({ name, scope, syntax }) =>
            typeof resolveUnqualifiedEffectOperation({
              name,
              scope,
              symbolTable: ctx.symbolTable,
              bindingIdentity: identifierBindingKey(syntax),
              directSymbol: ctx.directSymbolBySyntax.get(syntax.syntaxId),
            }) === "number",
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
      resolveBareHandlerHead: ({ name, scope, syntax }) =>
        typeof resolveUnqualifiedEffectOperation({
          name,
          scope,
          symbolTable: ctx.symbolTable,
          bindingIdentity: identifierBindingKey(syntax),
          directSymbol: ctx.directSymbolBySyntax.get(syntax.syntaxId),
        }) === "number",
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
      validateHandlerOperationBinding({
        head,
        ctx,
        scope: clauseScope,
      });
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
        bindMatchPatternType(arm.pattern, ctx, tracker);
        declareMatchPatternBindings(arm.pattern, ctx, caseScope);
        bindExpr(arm.value, ctx, tracker);
      });
    });
  });
};

const bindMatchPatternType = (
  pattern: SurfaceMatchPattern,
  ctx: BindingContext,
  tracker: BinderScopeTracker,
): void => {
  if (
    pattern.kind === "type" ||
    pattern.kind === "type-binding" ||
    pattern.kind === "destructure"
  ) {
    bindTypeExpr(pattern.typeExpr, ctx, tracker);
  }
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
        bindingIdentity: bindingIdentityForSyntax(param),
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
    syntax: param.name,
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
  if (identifier) {
    bindHygienicIdentifierReference(identifier, ctx, tracker.current());
  }
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

  const namespaceSymbol = resolveNamespaceModuleSymbol(target, scope, ctx);
  if (typeof namespaceSymbol === "number") {
    const targetRecord = ctx.symbolTable.getSymbol(namespaceSymbol);
    if (targetRecord.kind === "effect") {
      const operationSyntax = extractConstructorTargetIdentifier(member);
      if (!operationSyntax) {
        return;
      }
      ensureQualifiedEffectOperationImport({
        effectSymbol: namespaceSymbol,
        operationName: memberName,
        syntax: operationSyntax,
        ctx,
      });
      const operation = resolveQualifiedEffectOperation({
        effectSymbol: namespaceSymbol,
        name: memberName,
        symbolTable: ctx.symbolTable,
        moduleMembers: ctx.moduleMembers,
      });
      if (typeof operation !== "number") {
        ctx.diagnostics.push(
          diagnosticFromCode({
            code: "BD0009",
            params: {
              kind: "missing-effect-operation",
              effectName: targetRecord.name,
              operationName: memberName,
            },
            span: toSourceSpan(operationSyntax),
          }),
        );
        return;
      }
      ctx.directSymbolBySyntax.set(operationSyntax.syntaxId, operation);
      if (!isForm(member)) {
        ctx.diagnostics.push(
          diagnosticFromCode({
            code: "BD0009",
            params: {
              kind: "first-class-effect-operation",
              effectName: targetRecord.name,
              operationName: memberName,
            },
            span: toSourceSpan(member as Syntax),
          }),
        );
      }
      return;
    }

    const importMeta = targetRecord.metadata as {
      import?: { moduleId?: string };
    };
    const moduleId = importMeta.import?.moduleId;
    if (!moduleId) {
      return;
    }

    ensureModuleMemberImport({
      moduleId,
      moduleSymbol: namespaceSymbol,
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

  const targetSymbol =
    ctx.directSymbolBySyntax.get(identifier.syntaxId) ??
    (identifierBindingKey(identifier)
      ? ctx.symbolTable.resolveBinding(
          identifier.value,
          identifierBindingKey(identifier)!,
          scope,
        )
      : ctx.symbolTable.resolve(identifier.value, scope));
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
    const direct = ctx.directSymbolBySyntax.get(target.syntaxId);
    const bindingIdentity = identifierBindingKey(target);
    const symbol =
      direct ??
      (bindingIdentity
        ? ctx.symbolTable.resolveBinding(target.value, bindingIdentity, scope)
        : ctx.symbolTable.resolve(target.value, scope));
    if (typeof symbol !== "number") {
      return undefined;
    }
    const record = ctx.symbolTable.getSymbol(symbol);
    if (record.kind !== "module" && record.kind !== "effect") {
      return undefined;
    }
    ctx.directSymbolBySyntax.set(target.syntaxId, symbol);
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
    const memberSyntax = extractConstructorTargetIdentifier(right);
    if (memberSyntax) {
      ctx.directSymbolBySyntax.set(memberSyntax.syntaxId, candidate);
    }
    return candidate;
  }

  return undefined;
};

const ensureQualifiedEffectOperationImport = ({
  effectSymbol,
  operationName,
  syntax,
  ctx,
}: {
  effectSymbol: SymbolId;
  operationName: string;
  syntax: Syntax;
  ctx: BindingContext;
}): void => {
  if (
    typeof resolveQualifiedEffectOperation({
      effectSymbol,
      name: operationName,
      symbolTable: ctx.symbolTable,
      moduleMembers: ctx.moduleMembers,
    }) === "number"
  ) {
    return;
  }

  const effectRecord = ctx.symbolTable.getSymbol(effectSymbol);
  const importedEffect = importedSymbolTargetFromMetadata(
    effectRecord.metadata as Record<string, unknown> | undefined,
  );
  if (!importedEffect) {
    return;
  }
  const dependency = ctx.dependencies.get(importedEffect.moduleId);
  const operation = dependency?.decls
    .getEffect(importedEffect.symbol)
    ?.operations.find((candidate) => candidate.name === operationName);
  if (!dependency || !operation) {
    return;
  }

  const operationRecord = dependency.symbolTable.getSymbol(operation.symbol);
  const explicitlyTargetsStdSubmodule =
    importedModuleExplicitStdSubmoduleFrom(
      effectRecord.metadata as Record<string, unknown> | undefined,
    ) ?? false;
  const existingImport = ctx.imports.find((candidate) => {
    const record = ctx.symbolTable.getSymbol(candidate.local);
    const metadata = record.metadata as
      | { qualifiedOnlyEffectOperation?: unknown }
      | undefined;
    return (
      candidate.target?.moduleId === importedEffect.moduleId &&
      candidate.target.symbol === operation.symbol &&
      record.kind === "effect-op" &&
      metadata?.qualifiedOnlyEffectOperation === true
    );
  });
  const local =
    existingImport?.local ??
    ctx.symbolTable.declare(
      {
        name: operationName,
        kind: "effect-op",
        declaredAt: syntax.syntaxId,
        metadata: {
          import: {
            moduleId: importedEffect.moduleId,
            symbol: operation.symbol,
            explicitlyTargetsStdSubmodule,
          },
          qualifiedOnlyEffectOperation: true,
          ...(importableMetadataFrom(
            operationRecord.metadata as Record<string, unknown> | undefined,
          ) ?? {}),
        },
      },
      ctx.symbolTable.rootScope,
    );
  if (!existingImport) {
    ctx.imports.push({
      name: operationName,
      local,
      target: {
        moduleId: importedEffect.moduleId,
        symbol: operation.symbol,
      },
      visibility: moduleVisibility(),
      span: toSourceSpan(syntax),
    });
  }
  const operationTable =
    ctx.moduleMembers.get(effectSymbol) ?? new Map<string, Set<SymbolId>>();
  const operationSymbols = operationTable.get(operationName) ?? new Set();
  operationSymbols.add(local);
  operationTable.set(operationName, operationSymbols);
  ctx.moduleMembers.set(effectSymbol, operationTable);
};

const validateHandlerOperationBinding = ({
  head,
  ctx,
  scope,
  deferUnresolvedQualifier = true,
}: {
  head: SurfaceHandlerHead;
  ctx: BindingContext;
  scope: ScopeId;
  deferUnresolvedQualifier?: boolean;
}): void => {
  if (head.effectExpr) {
    const qualifier = resolveNamespaceModuleSymbol(head.effectExpr, scope, ctx);
    if (
      typeof qualifier === "number" &&
      ctx.symbolTable.getSymbol(qualifier).kind === "effect"
    ) {
      return;
    }
    if (qualifier === undefined && deferUnresolvedQualifier) {
      ctx.pendingHandlerOperationBindings.push({ head, scope });
      return;
    }
    ctx.diagnostics.push(
      diagnosticFromCode({
        code: "BD0009",
        params: {
          kind: "invalid-effect-handler-qualifier",
          qualifier: displayNamespaceQualifier(head.effectExpr),
          operationName: head.operation.value,
        },
        span: toSourceSpan(head.effectExpr),
      }),
    );
    return;
  }

  const operation = resolveUnqualifiedEffectOperation({
    name: head.operation.value,
    scope,
    symbolTable: ctx.symbolTable,
  });
  if (typeof operation === "number") {
    ctx.directSymbolBySyntax.set(head.operation.syntaxId, operation);
    return;
  }
  ctx.diagnostics.push(
    diagnosticFromCode({
      code: "BD0009",
      params: {
        kind: "handler-not-effect-operation",
        operationName: head.operation.value,
      },
      span: toSourceSpan(head.operation),
    }),
  );
};

const displayNamespaceQualifier = (expr: Expr): string => {
  const stripped = stripTypeArguments(expr);
  if (stripped !== expr) {
    return displayNamespaceQualifier(stripped);
  }
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    return expr.value;
  }
  if (!isForm(expr) || !expr.calls("::")) {
    return "this qualifier";
  }
  const left = expr.at(1);
  const right = extractMemberName(expr.at(2));
  return left && right
    ? `${displayNamespaceQualifier(left)}::${right}`
    : "this qualifier";
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

export const ensureStaticMethodImport = ({
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
  const hygienicReference =
    (targetRecord.metadata as { hygienicReference?: unknown } | undefined)
      ?.hygienicReference === true;
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
      hygienicReference,
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
        metadata: {
          import: { moduleId, symbol: importTargetSymbol },
          ...(hygienicReference ? { hygienicReference: true } : {}),
        },
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
  hygienicReference,
  allowSyntheticAliasConstructorFallback,
  ctx,
}: {
  importTargetSymbol: SymbolId;
  moduleId: string;
  dependency: BindingResult;
  explicitlyTargetsStdSubmodule: boolean;
  hygienicReference: boolean;
  allowSyntheticAliasConstructorFallback: boolean;
  ctx: BindingContext;
}): boolean => {
  if (hygienicReference) {
    return true;
  }

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

  const variantTarget = enumVariantTypeTargetsFromAliasTarget(
    aliasDecl.target,
  )?.find((entry) => entry.name === memberName);
  if (!variantTarget) {
    return;
  }

  const variantSymbol = resolveNominalTypeSymbol({
    target: variantTarget.target,
    scope: dependency.symbolTable.rootScope,
    symbolTable: dependency.symbolTable,
    moduleMembers: dependency.moduleMembers,
  });
  if (typeof variantSymbol !== "number") {
    return;
  }
  const variantRecord = dependency.symbolTable.getSymbol(variantSymbol);
  const metadata = variantRecord.metadata as { entity?: string } | undefined;
  if (variantRecord.kind !== "type" || metadata?.entity !== "object") {
    return;
  }

  // The public enum alias owns access to its private variant types. Import the
  // selected target directly without publishing its display name as a module
  // export.
  const importableMetadata = importableMetadataFrom(
    variantRecord.metadata as Record<string, unknown> | undefined,
  );
  const local = ctx.symbolTable.declare(
    {
      name: memberName,
      kind: variantRecord.kind,
      declaredAt: syntax.syntaxId,
      metadata: {
        import: {
          moduleId: importedTarget.moduleId,
          symbol: variantSymbol,
          explicitlyTargetsStdSubmodule,
        },
        ...(importableMetadata ?? {}),
      },
    },
    scope,
  );
  ctx.imports.push({
    name: memberName,
    local,
    target: { moduleId: importedTarget.moduleId, symbol: variantSymbol },
    visibility: moduleVisibility(),
    span: toSourceSpan(syntax),
  });
  const bucket = ctx.staticMethods.get(targetSymbol) ?? new Map();
  const members = bucket.get(memberName) ?? new Set<SymbolId>();
  members.add(local);
  bucket.set(memberName, members);
  ctx.staticMethods.set(targetSymbol, bucket);
  ensureConstructorImport({
    targetSymbol: local,
    syntax,
    scope,
    ctx,
  });
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
  const targetSymbol = resolveBoundIdentifierSymbol({
    identifier,
    ctx,
    scope,
  });
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

export const resolveBoundIdentifierSymbol = ({
  identifier,
  ctx,
  scope,
}: {
  identifier: IdentifierAtom | InternalIdentifierAtom;
  ctx: BindingContext;
  scope: ScopeId;
}): SymbolId | undefined => {
  const direct = ctx.directSymbolBySyntax.get(identifier.syntaxId);
  if (typeof direct === "number") {
    return direct;
  }
  const bindingIdentity = identifierBindingKey(identifier);
  return bindingIdentity
    ? ctx.symbolTable.resolveBinding(identifier.value, bindingIdentity, scope)
    : ctx.symbolTable.resolve(identifier.value, scope);
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
  const moduleExport = exported
    ? moduleNamespaceExportEntry(exported)
    : undefined;
  if (!moduleExport || moduleExport.kind === "effect-op") {
    const module = ctx.graph.modules.get(moduleId);
    const packageRootFile =
      module?.origin.kind === "file" &&
      isPackageRootModule(module.path, {
        sourcePackageRoot: module.sourcePackageRoot,
      })
        ? module.origin.filePath
        : undefined;
    const diagnosticModuleId = packageRootFile
      ? moduleId.replace(/::pkg$/, "")
      : moduleId;
    const ownerSymbol = exported
      ? firstInstanceMemberOwner(exported)
      : undefined;
    const dependency = ctx.dependencies.get(moduleId);
    const owner =
      typeof ownerSymbol === "number" && dependency
        ? dependency.symbolTable.getSymbol(ownerSymbol).name
        : undefined;
    ctx.diagnostics.push(
      diagnosticFromCode({
        code: "BD0001",
        params:
          exported && exported.kind !== "effect-op" && owner
            ? {
                kind: "instance-member-import",
                moduleId: diagnosticModuleId,
                target: memberName,
                owner,
              }
            : {
                kind: "missing-export",
                moduleId: diagnosticModuleId,
                target: memberName,
                packageRootFile,
              },
        span: toSourceSpan(syntax),
      }),
    );
    return;
  }
  const locals = declareModuleMemberImport({
    exported: moduleExport,
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
  const locals: number[] = [];
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
      syntax: pattern.name,
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
