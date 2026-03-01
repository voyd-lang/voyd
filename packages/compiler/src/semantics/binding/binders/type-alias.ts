import type { ParsedTypeAliasDecl } from "../parsing.js";
import type { BindingContext } from "../types.js";
import type { TypeAliasDecl, TypeParameterDecl } from "../../decls.js";
import { declarationDocForSyntax, rememberSyntax } from "../context.js";
import { bindTypeParameters } from "./type-parameters.js";
import type { BinderScopeTracker } from "./scope-tracker.js";
import { reportOverloadNameCollision } from "../name-collisions.js";
import { reportInvalidTypeDeclarationName } from "../type-name-convention.js";
import { ensureConstructorImport, ensureModuleMemberImport } from "./expressions.js";
import {
  enumNamespaceMetadataFromAliasTarget,
  enumVariantTypeNamesFromAliasTarget,
} from "../../enum-namespace.js";
import type { SymbolId } from "../../ids.js";
import {
  nominalTypeTargetMetadataFromAliasTarget,
  resolveNominalTypeSymbol,
} from "../../nominal-type-target.js";
import { importedModuleIdFrom } from "../../imports/metadata.js";

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
  const nominalTargetMetadata = nominalTypeTargetMetadataFromAliasTarget({
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
      ...(nominalTargetMetadata ?? {}),
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

  seedObjectAliasConstructorNamespaces(ctx);
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

const seedObjectAliasConstructorNamespaces = (ctx: BindingContext): void => {
  const aliasConstructorSymbols = new Map<string, SymbolId>();
  let changed = true;
  while (changed) {
    changed = false;
    ctx.decls.typeAliases.forEach((alias) => {
      const aliasScope =
        alias.form && ctx.scopeByNode.get(alias.form.syntaxId)
          ? (ctx.scopeByNode.get(alias.form.syntaxId) as number)
          : ctx.symbolTable.rootScope;
      const targetSymbol = resolveNominalTypeSymbol({
        target: alias.target,
        scope: aliasScope,
        symbolTable: ctx.symbolTable,
        moduleMembers: ctx.moduleMembers,
        ensureModuleMember: ({ moduleSymbol, memberName }) => {
          const moduleRecord = ctx.symbolTable.getSymbol(moduleSymbol);
          const moduleId = importedModuleIdFrom(
            moduleRecord.metadata as Record<string, unknown> | undefined,
          );
          if (!moduleId) {
            return;
          }
          ensureModuleMemberImport({
            moduleId,
            moduleSymbol,
            memberName,
            syntax: alias.target,
            scope: aliasScope,
            ctx,
          });
        },
      });
      if (typeof targetSymbol !== "number") {
        return;
      }
      const targetRecord = ctx.symbolTable.getSymbol(targetSymbol);
      if (targetRecord.kind !== "type") {
        return;
      }
      const aliasRecord = ctx.symbolTable.getSymbol(alias.symbol);
      const aliasMetadata = aliasRecord.metadata as
        | {
            nominalTargetTypeArguments?: unknown;
            nominalTargetTypeParameterNames?: unknown;
          }
        | undefined;
      const targetMetadata = targetRecord.metadata as
        | {
            nominalTargetTypeArguments?: unknown;
            nominalTargetTypeParameterNames?: unknown;
          }
        | undefined;
      const canCopyTargetNominalMetadata =
        (alias.typeParameters?.length ?? 0) === 0 &&
        !Array.isArray(aliasMetadata?.nominalTargetTypeArguments) &&
        Array.isArray(targetMetadata?.nominalTargetTypeArguments);
      if (canCopyTargetNominalMetadata) {
        ctx.symbolTable.setSymbolMetadata(alias.symbol, {
          nominalTargetTypeArguments: targetMetadata?.nominalTargetTypeArguments,
          nominalTargetTypeParameterNames:
            targetMetadata?.nominalTargetTypeParameterNames,
        });
      }
      ensureConstructorImport({
        targetSymbol,
        syntax: alias.target,
        scope: aliasScope,
        ctx,
      });
      const constructors = ctx.staticMethods.get(targetSymbol)?.get("init");
      if (!constructors || constructors.size === 0) {
        return;
      }
      const bucket = ctx.staticMethods.get(alias.symbol) ?? new Map();
      const aliasConstructors = bucket.get("init") ?? new Set<SymbolId>();
      const sizeBefore = aliasConstructors.size;
      constructors.forEach((constructorSymbol) => {
        const aliasConstructor = ensureAliasConstructorSymbol({
          alias,
          aliasScope,
          constructorSymbol,
          aliasConstructorSymbols,
          ctx,
        });
        aliasConstructors.add(aliasConstructor);
      });
      if (aliasConstructors.size === sizeBefore) {
        return;
      }
      bucket.set("init", aliasConstructors);
      ctx.staticMethods.set(alias.symbol, bucket);
      changed = true;
    });
  }
};

const ensureAliasConstructorSymbol = ({
  alias,
  aliasScope,
  constructorSymbol,
  aliasConstructorSymbols,
  ctx,
}: {
  alias: TypeAliasDecl;
  aliasScope: number;
  constructorSymbol: SymbolId;
  aliasConstructorSymbols: Map<string, SymbolId>;
  ctx: BindingContext;
}): SymbolId => {
  const key = `${alias.symbol}:${constructorSymbol}`;
  const cached = aliasConstructorSymbols.get(key);
  if (typeof cached === "number") {
    return cached;
  }

  const constructorRecord = ctx.symbolTable.getSymbol(constructorSymbol);
  const aliasRecord = ctx.symbolTable.getSymbol(alias.symbol);
  const aliasMetadata = aliasRecord.metadata as
    | {
        nominalTargetTypeArguments?: unknown;
        nominalTargetTypeParameterNames?: unknown;
      }
    | undefined;
  const local = ctx.symbolTable.declare(
    {
      name: constructorRecord.name,
      kind: "value",
      declaredAt: alias.form?.syntaxId ?? alias.target.syntaxId,
      metadata: {
        aliasConstructorTarget: constructorSymbol,
        aliasConstructorAlias: alias.symbol,
        nominalTargetTypeArguments: aliasMetadata?.nominalTargetTypeArguments,
        nominalTargetTypeParameterNames:
          aliasMetadata?.nominalTargetTypeParameterNames,
      },
    },
    aliasScope,
  );

  const overloadSet = ctx.overloadBySymbol.get(constructorSymbol);
  if (typeof overloadSet === "number") {
    ctx.overloadBySymbol.set(local, overloadSet);
  }

  aliasConstructorSymbols.set(key, local);
  return local;
};
