import { createTypingState } from "./context.js";
import { ensureObjectType, getObjectTemplate } from "./type-system.js";
import { importableMetadataFrom } from "../imports/metadata.js";
import type { DependencySemantics, TypingContext } from "./types.js";
import type { SymbolId, TypeId, TypeParamId } from "../ids.js";
import {
  createTranslation,
  mapTypeParam,
} from "./import-type-translation.js";
import { findExport, makeDependencyContext } from "./import-resolution.js";

export const registerImportedObjectTemplate = ({
  dependency,
  dependencySymbol,
  localSymbol,
  ctx,
}: {
  dependency: DependencySemantics;
  dependencySymbol: SymbolId;
  localSymbol: SymbolId;
  ctx: TypingContext;
}): void => {
  if (ctx.objects.getTemplate(localSymbol)) {
    return;
  }
  let template = dependency.typing.objects.getTemplate(dependencySymbol);
  if (!template) {
    const depCtx = makeDependencyContext(dependency, ctx);
    const state = createTypingState();
    template = getObjectTemplate(dependencySymbol, depCtx, state);
  }
  if (!template) {
    return;
  }

  const typeParamMap = new Map<TypeParamId, TypeParamId>();
  const cache = new Map<TypeId, TypeId>();
  const mapOwner = (symbol: SymbolId): SymbolId => {
    if (symbol === dependencySymbol) {
      return localSymbol;
    }
    if (symbol === dependency.typing.objects.base.symbol) {
      return ctx.objects.base.symbol;
    }
    try {
      return mapDependencySymbolToLocal({ owner: symbol, dependency, ctx });
    } catch {
      const depRecord = dependency.symbolTable.getSymbol(symbol);
      return ctx.symbolTable.declare({
        name: depRecord.name,
        kind: depRecord.kind,
        declaredAt: ctx.hir.module.ast,
      });
    }
  };
  const translation = createTranslation({
    sourceArena: dependency.typing.arena,
    targetArena: ctx.arena,
    sourceEffects: dependency.typing.effects,
    targetEffects: ctx.effects,
    paramMap: typeParamMap,
    cache,
    mapSymbol: mapOwner,
  });

  const paramSymbolMap = new Map<SymbolId, SymbolId>();
  const mapParamSymbol = (symbol: SymbolId): SymbolId => {
    const existing = paramSymbolMap.get(symbol);
    if (typeof existing === "number") {
      return existing;
    }
    const depRecord = dependency.symbolTable.getSymbol(symbol);
    const local = ctx.symbolTable.declare({
      name: depRecord.name,
      kind: "type-parameter",
      declaredAt: ctx.hir.module.ast,
    });
    paramSymbolMap.set(symbol, local);
    return local;
  };

  const translateTypeParam = (id: TypeParamId | undefined) =>
    typeof id === "number" ? typeParamMap.get(id) ?? id : undefined;

  const translateDeclaringParams = (
    params?: readonly TypeParamId[],
  ): readonly TypeParamId[] | undefined => {
    const translated = params
      ?.map(translateTypeParam)
      .filter((entry): entry is TypeParamId => typeof entry === "number");
    return translated && translated.length > 0 ? translated : undefined;
  };

  const params = template.params.map((param) => ({
    symbol: mapParamSymbol(param.symbol),
    typeParam: mapTypeParam(param.typeParam, typeParamMap, ctx),
    constraint: param.constraint ? translation(param.constraint) : undefined,
  }));

  const fields = template.fields.map((field) => ({
    name: field.name,
    type: translation(field.type),
    declaringParams: translateDeclaringParams(field.declaringParams),
    visibility: field.visibility,
    owner:
      typeof field.owner === "number" ? mapOwner(field.owner) : field.owner,
    packageId: field.packageId ?? dependency.packageId ?? ctx.packageId,
  }));

  ctx.objects.registerTemplate({
    symbol: localSymbol,
    params,
    nominal: translation(template.nominal),
    structural: translation(template.structural),
    type: translation(template.type),
    fields,
    visibility: template.visibility,
    baseNominal: template.baseNominal
      ? translation(template.baseNominal)
      : undefined,
  });
  const name = ctx.symbolTable.getSymbol(localSymbol).name;
  ctx.objects.setName(name, localSymbol);
  if (params.length === 0) {
    const state = createTypingState();
    ensureObjectType(localSymbol, ctx, state, []);
  }
};

export const mapDependencySymbolToLocal = ({
  owner,
  dependency,
  ctx,
  allowUnexported,
}: {
  owner: SymbolId;
  dependency: DependencySemantics;
  ctx: TypingContext;
  allowUnexported?: boolean;
}): SymbolId => {
  const visit = (
    candidateOwner: SymbolId,
    candidateDependency: DependencySemantics,
    seen: Set<string>,
  ): SymbolId => {
    const key = `${candidateDependency.moduleId}::${candidateOwner}`;
    if (seen.has(key)) {
      throw new Error(
        `cyclic import metadata while resolving symbol ${candidateOwner}`,
      );
    }
    seen.add(key);

    const aliases = ctx.importAliasesByModule.get(candidateDependency.moduleId);
    const aliased = aliases?.get(candidateOwner);
    if (typeof aliased === "number") {
      return aliased;
    }

    const exportEntry = findExport(candidateOwner, candidateDependency);
    if (!exportEntry) {
      const record = candidateDependency.symbolTable.getSymbol(candidateOwner);
      const importMetadata = (record.metadata ?? {}) as
        | { import?: { moduleId?: unknown; symbol?: unknown } }
        | undefined;
      const importModuleId = importMetadata?.import?.moduleId;
      const importSymbol = importMetadata?.import?.symbol;

      if (
        typeof importModuleId === "string" &&
        typeof importSymbol === "number"
      ) {
        const importedDependency = ctx.dependencies.get(importModuleId);
        if (importedDependency) {
          return visit(importSymbol, importedDependency, seen);
        }
      }

      if (allowUnexported === true) {
        const recordName = record.name;
        const importableMetadata = importableMetadataFrom(
          record.metadata as Record<string, unknown> | undefined,
        );
        const declared = ctx.symbolTable.declare({
          name: recordName,
          kind: record.kind,
          declaredAt: ctx.hir.module.ast,
          metadata: {
            import: {
              moduleId: candidateDependency.moduleId,
              symbol: candidateOwner,
            },
            ...(importableMetadata ?? {}),
          },
        });
        ctx.importsByLocal.set(declared, {
          moduleId: candidateDependency.moduleId,
          symbol: candidateOwner,
        });
        const bucket =
          ctx.importAliasesByModule.get(candidateDependency.moduleId) ??
          new Map();
        bucket.set(candidateOwner, declared);
        ctx.importAliasesByModule.set(candidateDependency.moduleId, bucket);
        if (
          record.kind === "type" ||
          candidateDependency.typing.objects.getTemplate(candidateOwner)
        ) {
          registerImportedObjectTemplate({
            dependency: candidateDependency,
            dependencySymbol: candidateOwner,
            localSymbol: declared,
            ctx,
          });
        }
        return declared;
      }

      throw new Error(
        `module ${candidateDependency.moduleId} does not export symbol ${candidateOwner}`,
      );
    }

    const dependencyRecord = candidateDependency.symbolTable.getSymbol(
      candidateOwner,
    );
    const importableMetadata = importableMetadataFrom(
      dependencyRecord.metadata as Record<string, unknown> | undefined,
    );
    const declared = ctx.symbolTable.declare({
      name: exportEntry.name,
      kind: exportEntry.kind,
      declaredAt: ctx.hir.module.ast,
      metadata: {
        import: { moduleId: candidateDependency.moduleId, symbol: candidateOwner },
        ...(importableMetadata ?? {}),
      },
    });
    ctx.importsByLocal.set(declared, {
      moduleId: candidateDependency.moduleId,
      symbol: candidateOwner,
    });
    const bucket =
      ctx.importAliasesByModule.get(candidateDependency.moduleId) ?? new Map();
    bucket.set(candidateOwner, declared);
    ctx.importAliasesByModule.set(candidateDependency.moduleId, bucket);
    if (
      exportEntry.kind === "type" ||
      candidateDependency.typing.objects.getTemplate(candidateOwner)
    ) {
      registerImportedObjectTemplate({
        dependency: candidateDependency,
        dependencySymbol: candidateOwner,
        localSymbol: declared,
        ctx,
      });
    }
    return declared;
  };

  return visit(owner, dependency, new Set());
};
