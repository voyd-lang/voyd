import { createTypingState } from "./context.js";
import {
  ensureObjectType,
  ensureTraitType,
  resolveTypeAlias,
} from "./type-system.js";
import { applyImportableMetadata } from "../imports/metadata.js";
import type {
  TypeCheckMode,
  TypingContext,
} from "./types.js";
import type { HirNamedTypeExpr } from "../hir/index.js";
import type {
  SymbolId,
  TypeId,
  TypeParamId,
  TypeSchemeId,
} from "../ids.js";
import { typingContextsShareInterners } from "./shared-interners.js";
import {
  createTranslation,
  createTypeTranslation,
  ensureImportedOwnerTemplatesAvailable,
  findExport,
  importTargetFor,
  makeDependencyContext,
  mapDependencySymbolToLocal,
  mapLocalSymbolToDependency,
  mapTypeParam,
  registerImportedObjectTemplate,
  registerImportedTraitDecl,
  registerImportedTraitImplTemplates,
  translateFunctionSignature,
} from "./imports-internal/index.js";
import { hydrateImportedTraitMetadataForDependencySymbol } from "./import-trait-impl-hydration.js";

export {
  createTypeTranslation,
  importTargetFor,
  mapDependencySymbolToLocal,
  registerImportedObjectTemplate,
  registerImportedTraitDecl,
  registerImportedTraitImplTemplates,
};

export const resolveImportedValue = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: TypingContext;
}): { type: TypeId; scheme?: TypeSchemeId } | undefined => {
  const target = importTargetFor(symbol, ctx);
  if (!target) {
    return undefined;
  }

  const dependency = ctx.dependencies.get(target.moduleId);
  if (!dependency) {
    throw new Error(
      `missing semantics for imported module ${target.moduleId}`,
    );
  }

  const dependencyRecord = dependency.symbolTable.getSymbol(target.symbol);
  applyImportableMetadata({
    symbolTable: ctx.symbolTable,
    symbol,
    source: dependencyRecord.metadata as Record<string, unknown> | undefined,
  });

  const dependencyMemberMetadata =
    dependency.typing.memberMetadata.get(target.symbol);
  if (dependencyMemberMetadata) {
    const owner =
      typeof dependencyMemberMetadata.owner === "number"
        ? mapDependencySymbolToLocal({
            owner: dependencyMemberMetadata.owner,
            dependency,
            ctx,
          })
        : undefined;
    ctx.memberMetadata.set(symbol, {
      owner,
      visibility: dependencyMemberMetadata.visibility,
      packageId: dependencyMemberMetadata.packageId ?? dependency.packageId,
    });
  }

  hydrateImportedTraitMetadataForDependencySymbol({
    dependency,
    dependencySymbol: target.symbol,
    localSymbol: symbol,
    ctx,
  });
  registerImportedObjectTemplate({
    dependency,
    dependencySymbol: target.symbol,
    localSymbol: symbol,
    ctx,
  });

  const exportEntry = findExport(target.symbol, dependency);
  if (!exportEntry) {
    throw new Error(
      `module ${target.moduleId} does not export symbol ${target.symbol}`,
    );
  }

  const sharedInterners = typingContextsShareInterners({
    sourceArena: dependency.typing.arena,
    targetArena: ctx.arena,
    sourceEffects: dependency.typing.effects,
    targetEffects: ctx.effects,
  });

  if (sharedInterners) {
    const scheme = dependency.typing.table.getSymbolScheme(target.symbol);
    if (typeof scheme === "number") {
      ctx.table.setSymbolScheme(symbol, scheme);
      const sourceScheme = ctx.arena.getScheme(scheme);
      ctx.valueTypes.set(symbol, sourceScheme.body);
      ensureImportedOwnerTemplatesAvailable({
        types: [sourceScheme.body],
        ctx,
      });
    }

    const signature = dependency.typing.functions.getSignature(target.symbol);
    if (signature) {
      ctx.functions.setSignature(symbol, signature);
      ctx.table.setSymbolScheme(symbol, signature.scheme);
      ctx.valueTypes.set(symbol, signature.typeId);
      ensureImportedOwnerTemplatesAvailable({
        types: [
          signature.typeId,
          signature.returnType,
          ...signature.parameters.map((param) => param.type),
        ],
        ctx,
      });
    }

    const resolvedType = ctx.valueTypes.get(symbol);
    if (typeof resolvedType !== "number") {
      return undefined;
    }
    return { type: resolvedType, scheme: ctx.table.getSymbolScheme(symbol) };
  }

  const paramMap = new Map<TypeParamId, TypeParamId>();
  const cache = new Map<TypeId, TypeId>();
  const translation = createTranslation({
    sourceArena: dependency.typing.arena,
    targetArena: ctx.arena,
    sourceEffects: dependency.typing.effects,
    targetEffects: ctx.effects,
    paramMap,
    cache,
    mapSymbol: (owner) =>
      mapDependencySymbolToLocal({
        owner,
        dependency,
        ctx,
      }),
  });

  const schemeId = dependency.typing.table.getSymbolScheme(target.symbol);
  let scheme: TypeSchemeId | undefined;
  if (typeof schemeId === "number") {
    const sourceScheme = dependency.typing.arena.getScheme(schemeId);
    const params = sourceScheme.params.map((param) =>
      mapTypeParam(param, paramMap, ctx),
    );
    const body = translation(sourceScheme.body);
    const constraints = sourceScheme.constraints
      ? {
          traits: sourceScheme.constraints.traits?.map(translation),
          structural: sourceScheme.constraints.structural?.map((entry) => ({
            field: entry.field,
            type: translation(entry.type),
          })),
        }
      : undefined;
    scheme = ctx.arena.newScheme(params, body, constraints);
    ctx.table.setSymbolScheme(symbol, scheme);
    ctx.valueTypes.set(symbol, body);
  }

  const signature = dependency.typing.functions.getSignature(target.symbol);
  if (signature) {
    const translated = translateFunctionSignature({
      signature,
      translation,
      dependency,
      ctx,
      paramMap,
    });
    ctx.functions.setSignature(symbol, translated.signature);
    if (!scheme) {
      scheme = translated.signature.scheme;
      ctx.table.setSymbolScheme(symbol, scheme);
    }
    ctx.valueTypes.set(symbol, translated.signature.typeId);
    ensureImportedOwnerTemplatesAvailable({
      types: [
        translated.signature.typeId,
        translated.signature.returnType,
        ...translated.signature.parameters.map((param) => param.type),
      ],
      ctx,
    });
    return { type: translated.signature.typeId, scheme };
  }

  if (typeof scheme === "number") {
    return { type: ctx.arena.getScheme(scheme).body, scheme };
  }

  return undefined;
};

export const resolveImportedTypeExpr = ({
  expr,
  typeArgs,
  ctx,
  state,
}: {
  expr: HirNamedTypeExpr;
  typeArgs: readonly TypeId[];
  ctx: TypingContext;
  state: { mode: TypeCheckMode };
}): TypeId | undefined => {
  const symbol = expr.symbol;
  if (typeof symbol !== "number") {
    return undefined;
  }
  const target = importTargetFor(symbol, ctx);
  if (!target) {
    return undefined;
  }

  const dependency = ctx.dependencies.get(target.moduleId);
  if (!dependency) {
    throw new Error(
      `missing semantics for imported module ${target.moduleId}`,
    );
  }
  hydrateImportedTraitMetadataForDependencySymbol({
    dependency,
    dependencySymbol: target.symbol,
    localSymbol: symbol,
    ctx,
  });
  registerImportedObjectTemplate({
    dependency,
    dependencySymbol: target.symbol,
    localSymbol: symbol,
    ctx,
  });

  const exportEntry = findExport(target.symbol, dependency);
  if (!exportEntry) {
    throw new Error(
      `module ${target.moduleId} does not export ${expr.path.join("::")}`,
    );
  }

  const depCtx = makeDependencyContext(dependency, ctx);
  const depState = createTypingState(state.mode);

  if (
    typingContextsShareInterners({
      sourceArena: depCtx.arena,
      targetArena: ctx.arena,
      sourceEffects: depCtx.effects,
      targetEffects: ctx.effects,
    })
  ) {
    const aliasResolved = resolveImportedAlias(target.symbol, typeArgs, depCtx, depState);
    const resolved =
      aliasResolved ??
      resolveImportedObject(target.symbol, typeArgs, depCtx, depState) ??
      resolveImportedTrait(target.symbol, typeArgs, depCtx, depState);
    if (typeof aliasResolved === "number") {
      ctx.typeAliases.recordInstanceSymbol(aliasResolved, symbol);
    }
    return resolved;
  }

  const forwardParamMap = new Map<TypeParamId, TypeParamId>();
  const forward = createTranslation({
    sourceArena: ctx.arena,
    targetArena: depCtx.arena,
    sourceEffects: ctx.effects,
    targetEffects: depCtx.effects,
    paramMap: forwardParamMap,
    cache: new Map(),
    mapSymbol: (owner) =>
      mapLocalSymbolToDependency({ owner, dependency, ctx }),
  });
  const reverseParamMap = new Map<TypeParamId, TypeParamId>();
  const back = createTranslation({
    sourceArena: depCtx.arena,
    targetArena: ctx.arena,
    sourceEffects: depCtx.effects,
    targetEffects: ctx.effects,
    paramMap: reverseParamMap,
    cache: new Map(),
    mapSymbol: (owner) =>
      mapDependencySymbolToLocal({ owner, dependency, ctx }),
  });

  const depArgs = typeArgs.map((arg) => forward(arg));
  forwardParamMap.forEach((targetParam, sourceParam) => {
    reverseParamMap.set(targetParam, sourceParam);
  });
  const aliasResolved = resolveImportedAlias(target.symbol, depArgs, depCtx, depState);
  const resolved =
    aliasResolved ??
    resolveImportedObject(target.symbol, depArgs, depCtx, depState) ??
    resolveImportedTrait(target.symbol, depArgs, depCtx, depState);

  const localType = typeof resolved === "number" ? back(resolved) : undefined;
  if (typeof aliasResolved === "number" && typeof localType === "number") {
    ctx.typeAliases.recordInstanceSymbol(localType, symbol);
  }
  return localType;
};

const resolveImportedAlias = (
  symbol: SymbolId,
  args: readonly TypeId[],
  ctx: TypingContext,
  state: ReturnType<typeof createTypingState>,
): TypeId | undefined => {
  if (!ctx.typeAliases.hasTemplate(symbol)) {
    return undefined;
  }
  return resolveTypeAlias(symbol, ctx, state, args);
};

const resolveImportedObject = (
  symbol: SymbolId,
  args: readonly TypeId[],
  ctx: TypingContext,
  state: ReturnType<typeof createTypingState>,
): TypeId | undefined => {
  const template = ctx.objects.getTemplate(symbol);
  if (!template) {
    return undefined;
  }
  return ensureObjectType(symbol, ctx, state, args)?.type;
};

const resolveImportedTrait = (
  symbol: SymbolId,
  args: readonly TypeId[],
  ctx: TypingContext,
  state: ReturnType<typeof createTypingState>,
): TypeId | undefined => {
  const decl = ctx.traits.getDecl(symbol);
  if (!decl) {
    return undefined;
  }
  return ensureTraitType(symbol, ctx, state, args);
};
