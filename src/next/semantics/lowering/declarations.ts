import { toSourceSpan } from "../utils.js";
import { createLowerScopeStack } from "./context.js";
import { lowerExpr } from "./expressions.js";
import { lowerTypeExpr, lowerTypeParameters } from "./type-expressions.js";
import type { LowerContext, ModuleDeclaration } from "./types.js";
import type { BindingResult, BoundFunction, BoundObject, BoundTypeAlias } from "../binding/binding.js";

export const getModuleDeclarations = (
  binding: BindingResult
): ModuleDeclaration[] => {
  const entries: ModuleDeclaration[] = [
    ...binding.functions.map((fn) => ({
      kind: "function" as const,
      order: fn.moduleIndex,
      fn,
    })),
    ...binding.typeAliases.map((alias) => ({
      kind: "type-alias" as const,
      order: alias.moduleIndex,
      alias,
    })),
    ...binding.objects.map((object) => ({
      kind: "object" as const,
      order: object.moduleIndex,
      object,
    })),
  ];

  return entries.sort((a, b) => a.order - b.order);
};

export const lowerFunctionDecl = (
  fn: BoundFunction,
  ctx: LowerContext
): void => {
  const scopes = createLowerScopeStack(fn.scope);
  const fallbackSyntax = fn.form ?? fn.body;

  const parameters = fn.params.map((param) => ({
    decl: param.id,
    symbol: param.symbol,
    pattern: { kind: "identifier", symbol: param.symbol } as const,
    label: param.label,
    span: toSourceSpan(param.ast ?? fallbackSyntax),
    mutable: false,
    type: lowerTypeExpr(param.typeExpr, ctx, scopes.current()),
  }));

  const bodyId = lowerExpr(fn.body, ctx, scopes);
  const fnId = ctx.builder.addFunction({
    kind: "function",
    decl: fn.id,
    visibility: fn.visibility,
    symbol: fn.symbol,
    ast: (fn.form ?? fn.body).syntaxId,
    span: toSourceSpan(fallbackSyntax),
    parameters,
    returnType: lowerTypeExpr(fn.returnTypeExpr, ctx, scopes.current()),
    body: bodyId,
  });

  if (fn.visibility === "public") {
    ctx.builder.recordExport({
      symbol: fn.symbol,
      visibility: "public",
      span: toSourceSpan(fn.form),
      item: fnId,
    });
  }
};

export const lowerTypeAliasDecl = (
  alias: BoundTypeAlias,
  ctx: LowerContext
): void => {
  const target = lowerTypeExpr(alias.target, ctx);
  if (!target) {
    throw new Error("type alias requires a target type expression");
  }

  const aliasSyntax = alias.form ?? alias.target;

  const aliasId = ctx.builder.addItem({
    kind: "type-alias",
    decl: alias.id,
    symbol: alias.symbol,
    visibility: alias.visibility,
    ast: aliasSyntax.syntaxId,
    span: toSourceSpan(aliasSyntax),
    target,
  });

  if (alias.visibility === "public") {
    ctx.builder.recordExport({
      symbol: alias.symbol,
      visibility: alias.visibility,
      span: toSourceSpan(alias.form),
      item: aliasId,
    });
  }
};

export const lowerObjectDecl = (
  object: BoundObject,
  ctx: LowerContext
): void => {
  const objectScope =
    (object.form && ctx.scopeByNode.get(object.form.syntaxId)) ??
    ctx.symbolTable.rootScope;

  const fields = object.fields.map((field) => ({
    name: field.name,
    symbol: field.symbol,
    type: lowerTypeExpr(field.typeExpr, ctx, objectScope),
    span: toSourceSpan(field.ast ?? object.form),
  }));

  const base = lowerTypeExpr(object.baseTypeExpr, ctx, objectScope);
  const baseSymbol = base && base.typeKind === "named" ? base.symbol : undefined;

  const objectSyntax =
    object.form ?? object.baseTypeExpr ?? object.fields[0]?.ast;
  if (!objectSyntax) {
    throw new Error("object declaration missing source syntax");
  }

  const objectId = ctx.builder.addItem({
    kind: "object",
    symbol: object.symbol,
    visibility: object.visibility,
    typeParameters: lowerTypeParameters(object.typeParameters),
    ast: objectSyntax.syntaxId,
    span: toSourceSpan(objectSyntax),
    base,
    baseSymbol,
    fields,
    isFinal: false,
  });

  if (object.visibility === "public") {
    ctx.builder.recordExport({
      symbol: object.symbol,
      visibility: object.visibility,
      span: toSourceSpan(object.form),
      item: objectId,
    });
  }
};
