import type { ParsedTypeAliasDecl } from "../parsing.js";
import type { BindingContext } from "../types.js";
import type { TypeParameterDecl } from "../../decls.js";
import { declarationDocForSyntax, rememberSyntax } from "../context.js";
import { bindTypeParameters } from "./type-parameters.js";
import type { BinderScopeTracker } from "./scope-tracker.js";
import { reportOverloadNameCollision } from "../name-collisions.js";
import { reportInvalidTypeDeclarationName } from "../type-name-convention.js";
import {
  enumNamespaceMetadataFromAliasTarget,
  enumVariantTypeNamesFromAliasTarget,
} from "../../enum-namespace.js";
import type { SymbolId } from "../../ids.js";

export const bindTypeAlias = (
  decl: ParsedTypeAliasDecl,
  ctx: BindingContext,
  tracker: BinderScopeTracker
): void => {
  rememberSyntax(decl.form, ctx);
  rememberSyntax(decl.name, ctx);
  rememberSyntax(decl.target, ctx);
  reportInvalidTypeDeclarationName({
    declarationKind: "type alias",
    name: decl.name,
    ctx,
  });

  const intrinsicType = decl.form.attributes?.intrinsicType;
  const intrinsicTypeMetadata =
    typeof intrinsicType === "string" ? { intrinsicType } : undefined;
  const enumNamespaceMetadata = enumNamespaceMetadataFromAliasTarget({
    target: decl.target,
    typeParameterNames: decl.typeParameters.map((entry) => entry.name.value),
  });
  reportOverloadNameCollision({
    name: decl.name.value,
    scope: tracker.current(),
    syntax: decl.name,
    ctx,
  });

  const symbol = ctx.symbolTable.declare({
    name: decl.name.value,
    kind: "type",
    declaredAt: decl.form.syntaxId,
    metadata: {
      entity: "type-alias",
      ...intrinsicTypeMetadata,
      ...(enumNamespaceMetadata ?? {}),
    },
  });

  const aliasScope = ctx.symbolTable.createScope({
    parent: tracker.current(),
    kind: "module",
    owner: decl.form.syntaxId,
  });
  ctx.scopeByNode.set(decl.form.syntaxId, aliasScope);

  let typeParameters: TypeParameterDecl[] = [];
  tracker.enterScope(aliasScope, () => {
    typeParameters = bindTypeParameters(decl.typeParameters, ctx);
  });

  ctx.decls.registerTypeAlias({
    name: decl.name.value,
    form: decl.form,
    visibility: decl.visibility,
    symbol,
    target: decl.target,
    typeParameters,
    moduleIndex: ctx.nextModuleIndex++,
    documentation: declarationDocForSyntax(decl.name, ctx),
  });
};

export const seedEnumAliasNamespaces = (ctx: BindingContext): void => {
  ctx.decls.typeAliases.forEach((alias) => {
    seedEnumVariantNamespace({
      aliasSymbol: alias.symbol,
      target: alias.target,
      scope: ctx.symbolTable.rootScope,
      ctx,
    });
  });
};

const seedEnumVariantNamespace = ({
  aliasSymbol,
  target,
  scope,
  ctx,
}: {
  aliasSymbol: SymbolId;
  target: ParsedTypeAliasDecl["target"];
  scope: number;
  ctx: BindingContext;
}): void => {
  const variantNames = enumVariantTypeNamesFromAliasTarget(target);
  if (!variantNames) {
    return;
  }

  const bucket = ctx.staticMethods.get(aliasSymbol) ?? new Map();
  let seeded = false;

  variantNames.forEach((variantName) => {
    const variantSymbol = resolveObjectTypeSymbol({
      name: variantName,
      scope,
      ctx,
    });
    if (typeof variantSymbol !== "number") {
      return;
    }

    const symbols = bucket.get(variantName) ?? new Set<SymbolId>();
    symbols.add(variantSymbol);
    bucket.set(variantName, symbols);
    seeded = true;
  });

  if (!seeded) {
    return;
  }
  ctx.staticMethods.set(aliasSymbol, bucket);
};

const resolveObjectTypeSymbol = ({
  name,
  scope,
  ctx,
}: {
  name: string;
  scope: number;
  ctx: BindingContext;
}): SymbolId | undefined => {
  const symbol = ctx.symbolTable.resolve(name, scope);
  if (typeof symbol !== "number") {
    return undefined;
  }

  const record = ctx.symbolTable.getSymbol(symbol);
  const metadata = record.metadata as { entity?: string } | undefined;
  if (record.kind !== "type" || metadata?.entity !== "object") {
    return undefined;
  }

  return symbol;
};
