import { toSourceSpan } from "../utils.js";
import { createLowerScopeStack } from "./context.js";
import { lowerExpr } from "./expressions.js";
import { lowerTypeExpr, lowerTypeParameters } from "./type-expressions.js";
import type { LowerContext, ModuleDeclaration } from "./types.js";
import type {
  BindingResult,
  BoundFunction,
  BoundObject,
  BoundTypeAlias,
  BoundTrait,
  BoundImpl,
  BoundUse,
} from "../binding/binding.js";
import type { Syntax } from "../../parser/index.js";

export const getModuleDeclarations = (
  binding: BindingResult
): ModuleDeclaration[] => {
  const entries: ModuleDeclaration[] = [
    ...binding.uses.map((use) => ({
      kind: "use" as const,
      order: use.order,
      use,
    })),
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
    ...binding.traits.map((trait) => ({
      kind: "trait" as const,
      order: trait.moduleIndex,
      trait,
    })),
    ...binding.impls.map((impl) => ({
      kind: "impl" as const,
      order: impl.moduleIndex,
      impl,
    })),
  ];

  return entries.sort((a, b) => a.order - b.order);
};

export const lowerUseDecl = (use: BoundUse, ctx: LowerContext): void => {
  const entries = use.entries.map((entry) => ({
    path: entry.path,
    alias: entry.alias,
    importKind: entry.importKind,
    span: entry.span,
  }));

  const useId = ctx.builder.addItem({
    kind: "use",
    visibility: use.visibility,
    entries,
    ast: use.form.syntaxId,
    span: toSourceSpan(use.form),
  });

  if (use.visibility === "public") {
    use.entries.forEach((entry) =>
      entry.imports.forEach((imported) => {
        if (!imported.target) {
          return;
        }
        ctx.builder.recordExport({
          symbol: imported.local,
          visibility: "public",
          span: entry.span,
          item: useId,
          alias: entry.alias,
        });
      })
    );
  }
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
    pattern: {
      kind: "identifier",
      symbol: param.symbol,
      bindingKind: param.bindingKind,
      span: toSourceSpan(param.ast ?? fallbackSyntax),
    } as const,
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
    typeParameters: lowerTypeParameters(fn.typeParameters),
    ast: (fn.form ?? fn.body).syntaxId,
    span: toSourceSpan(fallbackSyntax),
    parameters,
    returnType: lowerTypeExpr(fn.returnTypeExpr, ctx, scopes.current()),
    body: bodyId,
    ...(fn.intrinsic ? { intrinsic: fn.intrinsic } : {}),
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
  const aliasScope =
    (alias.form && ctx.scopeByNode.get(alias.form.syntaxId)) ??
    ctx.symbolTable.rootScope;
  const target = lowerTypeExpr(alias.target, ctx, aliasScope);
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
    typeParameters: lowerTypeParameters(alias.typeParameters),
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

export const lowerTraitDecl = (
  trait: BoundTrait,
  ctx: LowerContext
): void => {
  const traitScope =
    trait.scope ??
    ctx.scopeByNode.get(trait.form?.syntaxId ?? trait.scope) ??
    ctx.symbolTable.rootScope;

  const methods = trait.methods.map((method) => {
    const methodScope =
      method.scope ??
      ctx.scopeByNode.get(method.form?.syntaxId ?? method.scope) ??
      traitScope;
    const parameters = method.params.map((param) => ({
      symbol: param.symbol,
      span: toSourceSpan(param.ast ?? method.form ?? trait.form),
      type: lowerTypeExpr(param.typeExpr, ctx, methodScope),
      mutable: false,
      bindingKind: param.bindingKind,
    }));

    const scopes = createLowerScopeStack(methodScope);
    const defaultBody = method.defaultBody
      ? lowerExpr(method.defaultBody, ctx, scopes)
      : undefined;

    return {
      symbol: method.symbol,
      span: toSourceSpan(method.form ?? trait.form),
      typeParameters: lowerTypeParameters(method.typeParameters),
      parameters,
      returnType: lowerTypeExpr(
        method.returnTypeExpr,
        ctx,
        methodScope
      ),
      defaultBody,
    };
  });

  const traitSyntax = trait.form ?? trait.methods[0]?.form;
  const traitId = ctx.builder.addItem({
    kind: "trait",
    symbol: trait.symbol,
    visibility: trait.visibility,
    ast: (traitSyntax as Syntax | undefined)?.syntaxId ?? ctx.moduleNodeId,
    span: toSourceSpan(traitSyntax),
    typeParameters: lowerTypeParameters(trait.typeParameters),
    requirements: undefined,
    methods,
  });

  if (trait.visibility === "public") {
    ctx.builder.recordExport({
      symbol: trait.symbol,
      visibility: trait.visibility,
      span: toSourceSpan(trait.form),
      item: traitId,
    });
  }
};

export const lowerImplDecl = (
  impl: BoundImpl,
  ctx: LowerContext
): void => {
  const implScope = ctx.scopeByNode.get(impl.form?.syntaxId ?? impl.scope);
  const target = lowerTypeExpr(
    impl.target,
    ctx,
    implScope ?? impl.scope ?? ctx.symbolTable.rootScope
  );
  if (!target) {
    throw new Error("impl requires a target type expression");
  }

  const trait = impl.trait
    ? lowerTypeExpr(impl.trait, ctx, implScope ?? ctx.symbolTable.rootScope)
    : undefined;

  const members = impl.methods.map((method) => {
    const memberId = findFunctionItemId(method.symbol, ctx);
    if (typeof memberId !== "number") {
      const { name } = ctx.symbolTable.getSymbol(method.symbol);
      throw new Error(`missing function item for impl method ${name}`);
    }
    return memberId;
  });

  const syntax = impl.form ?? impl.target;
  const implId = ctx.builder.addItem({
    kind: "impl",
    symbol: impl.symbol,
    visibility: impl.visibility,
    ast: (syntax as Syntax | undefined)?.syntaxId ?? ctx.moduleNodeId,
    span: toSourceSpan(syntax),
    typeParameters: lowerTypeParameters(impl.typeParameters),
    target,
    trait,
    with: undefined,
    members,
  });

  if (impl.visibility === "public") {
    ctx.builder.recordExport({
      symbol: impl.symbol,
      visibility: impl.visibility,
      span: toSourceSpan(impl.form),
      item: implId,
    });
  }
};

const findFunctionItemId = (
  symbol: number,
  ctx: LowerContext
): number | undefined => {
  for (const itemId of ctx.builder.module.items) {
    const node = ctx.builder.getNode(itemId);
    if (node && node.kind === "function" && (node as any).symbol === symbol) {
      return itemId;
    }
  }
  return undefined;
};
