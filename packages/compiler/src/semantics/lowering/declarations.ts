import { toSourceSpan } from "../utils.js";
import { createLowerScopeStack } from "./context.js";
import { lowerExpr } from "./expressions/index.js";
import {
  lowerTypeExpr,
  lowerTypeParameters,
  wrapInOptionalTypeExpr,
} from "./type-expressions.js";
import type { LowerContext, ModuleDeclaration } from "./types.js";
import type {
  BindingResult,
  BoundFunction,
  BoundModuleLet,
  BoundObject,
  BoundTypeAlias,
  BoundTrait,
  BoundImpl,
  BoundEffect,
  BoundUse,
} from "../binding/binding.js";
import type { Syntax } from "../../parser/index.js";
import {
  isPackageVisible,
  type HirVisibility,
} from "../hir/index.js";

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
    ...binding.moduleLets.map((moduleLet) => ({
      kind: "module-let" as const,
      order: moduleLet.moduleIndex,
      moduleLet,
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
    ...binding.effects.map((effect) => ({
      kind: "effect" as const,
      order: effect.moduleIndex,
      effect,
    })),
    ...binding.impls.map((impl) => ({
      kind: "impl" as const,
      order: impl.moduleIndex,
      impl,
    })),
  ];

  return entries.sort((a, b) => a.order - b.order);
};

const toExportVisibility = (
  visibility: HirVisibility,
  ctx: LowerContext
): HirVisibility => {
  if (!isPackageVisible(visibility)) {
    return visibility;
  }
  if (ctx.isPackageRoot && visibility.level !== "public") {
    return { ...visibility, level: "public" };
  }
  return visibility;
};

const toHirImportKind = (
  selectionKind: BoundUse["entries"][number]["selectionKind"],
): "name" | "self" | "all" =>
  selectionKind === "module"
    ? "self"
    : selectionKind === "all"
      ? "all"
      : "name";

export const lowerUseDecl = (use: BoundUse, ctx: LowerContext): void => {
  const entries = use.entries.map((entry) => ({
    path: entry.path,
    alias: entry.alias,
    importKind: toHirImportKind(entry.selectionKind),
    span: entry.span,
  }));

  const useId = ctx.builder.addItem({
    kind: "use",
    visibility: use.visibility,
    entries,
    ast: use.form.syntaxId,
    span: toSourceSpan(use.form),
  });

  if (isPackageVisible(use.visibility)) {
    const exportVisibility = toExportVisibility(use.visibility, ctx);
    use.entries.forEach((entry) =>
      entry.imports.forEach((imported) => {
        ctx.builder.recordExport({
          symbol: imported.local,
          visibility: exportVisibility,
          span: entry.span,
          item: useId,
          alias: entry.selectionKind === "all" ? undefined : entry.alias,
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

  const currentScope = scopes.current();
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
    ...(param.optional ? { optional: true } : {}),
    span: toSourceSpan(param.ast ?? fallbackSyntax),
    mutable: false,
    type: (() => {
      const lowered = lowerTypeExpr(param.typeExpr, ctx, currentScope);
      if (!param.optional) {
        return lowered;
      }
      if (!lowered) {
        throw new Error(
          `optional parameter ${param.name} must declare a type annotation`
        );
      }
      return wrapInOptionalTypeExpr({ inner: lowered, ctx, scope: currentScope });
    })(),
  }));

  const bodyId = lowerExpr(fn.body, ctx, scopes);
  const effectType = lowerTypeExpr(fn.effectTypeExpr, ctx, currentScope);
  const fnId = ctx.builder.addFunction({
    kind: "function",
    decl: fn.id,
    visibility: fn.visibility,
    memberVisibility: fn.memberVisibility,
    symbol: fn.symbol,
    typeParameters: lowerTypeParameters({
      params: fn.typeParameters,
      ctx,
      scope: currentScope,
    }),
    ast: (fn.form ?? fn.body).syntaxId,
    span: toSourceSpan(fallbackSyntax),
    parameters,
    returnType: lowerTypeExpr(fn.returnTypeExpr, ctx, currentScope),
    ...(effectType ? { effectType } : {}),
    body: bodyId,
    ...(fn.intrinsic ? { intrinsic: fn.intrinsic } : {}),
  });

  if (isPackageVisible(fn.visibility)) {
    ctx.builder.recordExport({
      symbol: fn.symbol,
      visibility: toExportVisibility(fn.visibility, ctx),
      span: toSourceSpan(fn.form),
      item: fnId,
    });
  }
};

export const lowerModuleLetDecl = (
  moduleLet: BoundModuleLet,
  ctx: LowerContext,
): void => {
  const scopes = createLowerScopeStack(ctx.symbolTable.rootScope);
  const initializer = lowerExpr(moduleLet.initializer, ctx, scopes);
  const typeAnnotation = lowerTypeExpr(
    moduleLet.typeExpr,
    ctx,
    scopes.current(),
  );
  const moduleLetId = ctx.builder.addItem({
    kind: "module-let",
    symbol: moduleLet.symbol,
    visibility: moduleLet.visibility,
    ast: moduleLet.form?.syntaxId ?? moduleLet.initializer.syntaxId,
    span: toSourceSpan(moduleLet.form ?? moduleLet.initializer),
    initializer,
    typeAnnotation,
  });

  if (isPackageVisible(moduleLet.visibility)) {
    ctx.builder.recordExport({
      symbol: moduleLet.symbol,
      visibility: toExportVisibility(moduleLet.visibility, ctx),
      span: toSourceSpan(moduleLet.form ?? moduleLet.initializer),
      item: moduleLetId,
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
    typeParameters: lowerTypeParameters({
      params: alias.typeParameters,
      ctx,
      scope: aliasScope,
    }),
    target,
  });

  if (isPackageVisible(alias.visibility)) {
    ctx.builder.recordExport({
      symbol: alias.symbol,
      visibility: toExportVisibility(alias.visibility, ctx),
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
    visibility: field.visibility,
    ...(field.optional ? { optional: true } : {}),
    type: (() => {
      const lowered = lowerTypeExpr(field.typeExpr, ctx, objectScope);
      if (!field.optional) {
        return lowered;
      }
      if (!lowered) {
        throw new Error(`optional field ${field.name} must declare a type`);
      }
      return wrapInOptionalTypeExpr({ inner: lowered, ctx, scope: objectScope });
    })(),
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
    typeParameters: lowerTypeParameters({
      params: object.typeParameters,
      ctx,
      scope: objectScope,
    }),
    ast: objectSyntax.syntaxId,
    span: toSourceSpan(objectSyntax),
    base,
    baseSymbol,
    fields,
    isFinal: false,
  });

  if (isPackageVisible(object.visibility)) {
    ctx.builder.recordExport({
      symbol: object.symbol,
      visibility: toExportVisibility(object.visibility, ctx),
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
      label: param.label,
      type: lowerTypeExpr(param.typeExpr, ctx, methodScope),
      mutable: false,
      bindingKind: param.bindingKind,
    }));

    const scopes = createLowerScopeStack(methodScope);
    const defaultBody = method.defaultBody
      ? lowerExpr(method.defaultBody, ctx, scopes)
      : undefined;

    const effectType = lowerTypeExpr(method.effectTypeExpr, ctx, methodScope);
    return {
      symbol: method.symbol,
      span: toSourceSpan(method.form ?? trait.form),
      typeParameters: lowerTypeParameters({
        params: method.typeParameters,
        ctx,
        scope: methodScope,
      }),
      parameters,
      returnType: lowerTypeExpr(
        method.returnTypeExpr,
        ctx,
        methodScope
      ),
      ...(effectType ? { effectType } : {}),
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
    typeParameters: lowerTypeParameters({
      params: trait.typeParameters,
      ctx,
      scope: traitScope,
    }),
    requirements: undefined,
    methods,
  });

  if (isPackageVisible(trait.visibility)) {
    ctx.builder.recordExport({
      symbol: trait.symbol,
      visibility: toExportVisibility(trait.visibility, ctx),
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
    typeParameters: lowerTypeParameters({
      params: impl.typeParameters,
      ctx,
      scope: implScope ?? impl.scope ?? ctx.symbolTable.rootScope,
    }),
    target,
    trait,
    with: undefined,
    members,
  });

  if (isPackageVisible(impl.visibility)) {
    ctx.builder.recordExport({
      symbol: impl.symbol,
      visibility: toExportVisibility(impl.visibility, ctx),
      span: toSourceSpan(impl.form),
      item: implId,
    });
  }
};

export const lowerEffectDecl = (
  effect: BoundEffect,
  ctx: LowerContext
): void => {
  const effectScope =
    effect.scope ??
    ctx.scopeByNode.get(effect.form?.syntaxId ?? effect.scope) ??
    ctx.symbolTable.rootScope;

  const operations = effect.operations.map((op) => {
    const opScope =
      ctx.scopeByNode.get(op.ast?.syntaxId ?? effectScope) ?? effectScope;
    const parameters = op.parameters.map((param) => ({
      symbol: param.symbol,
      span: toSourceSpan(param.ast ?? op.ast ?? effect.form),
      type: lowerTypeExpr(param.typeExpr, ctx, opScope),
      mutable: false,
      bindingKind: param.bindingKind,
    }));
    const resumableMode: "ctl" | "fn" =
      op.resumable === "tail" ? "fn" : "ctl";
    return {
      symbol: op.symbol,
      span: toSourceSpan(op.ast ?? effect.form),
      resumable: resumableMode,
      parameters,
      returnType: lowerTypeExpr(op.returnTypeExpr, ctx, opScope),
    };
  });

  const effectId = ctx.builder.addItem({
    kind: "effect",
    symbol: effect.symbol,
    visibility: effect.visibility,
    ast: (effect.form ?? effect.operations[0]?.ast)?.syntaxId ?? ctx.moduleNodeId,
    span: toSourceSpan(effect.form),
    typeParameters: lowerTypeParameters({
      params: effect.typeParameters,
      ctx,
      scope: effectScope,
    }),
    operations,
  });

  if (isPackageVisible(effect.visibility)) {
    ctx.builder.recordExport({
      symbol: effect.symbol,
      visibility: toExportVisibility(effect.visibility, ctx),
      span: toSourceSpan(effect.form),
      item: effectId,
    });
    operations.forEach((op) => {
      ctx.builder.recordExport({
        alias: ctx.symbolTable.getSymbol(op.symbol).name,
        symbol: op.symbol,
        visibility: toExportVisibility(effect.visibility, ctx),
        span: toSourceSpan(effect.form),
        item: effectId,
      });
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
