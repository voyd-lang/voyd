import type { SymbolId, TypeId } from "../ids.js";
import { importTargetFor } from "./import-resolution.js";
import { localSymbolForSymbolRef } from "./symbol-ref-utils.js";
import {
  mapDependencySymbolToLocal,
  registerImportedTraitDecl,
  registerImportedTraitImplTemplates,
} from "./import-symbol-mapping.js";
import type { DependencySemantics, TypingContext } from "./types.js";

type DependencySymbolResolution = {
  dependency: DependencySemantics;
  dependencySymbol: SymbolId;
};

const resolveDependencySymbol = ({
  ownerModuleId,
  ownerSymbol,
  preferredDependency,
  ctx,
}: {
  ownerModuleId: string;
  ownerSymbol: SymbolId;
  preferredDependency?: DependencySemantics;
  ctx: TypingContext;
}): DependencySymbolResolution | undefined => {
  const dependency =
    preferredDependency && preferredDependency.moduleId === ownerModuleId
      ? preferredDependency
      : ctx.dependencies.get(ownerModuleId);
  if (!dependency) {
    return undefined;
  }
  return { dependency, dependencySymbol: ownerSymbol };
};

export const hydrateImportedTraitMetadataForDependencySymbol = ({
  dependency,
  dependencySymbol,
  localSymbol,
  ctx,
}: {
  dependency: DependencySemantics;
  dependencySymbol: SymbolId;
  localSymbol?: SymbolId;
  ctx: TypingContext;
}): void => {
  const localTraitSymbol =
    typeof localSymbol === "number"
      ? localSymbol
      : mapDependencySymbolToLocal({
          owner: dependencySymbol,
          dependency,
          ctx,
          allowUnexported: true,
        });
  registerImportedTraitDecl({
    dependency,
    dependencySymbol,
    localSymbol: localTraitSymbol,
    ctx,
  });
  registerImportedTraitImplTemplates({
    dependency,
    dependencySymbol,
    ctx,
  });
};

export const hydrateImportedTraitMetadataForOwnerRef = ({
  ownerModuleId,
  ownerSymbol,
  preferredDependency,
  ctx,
}: {
  ownerModuleId: string;
  ownerSymbol: SymbolId;
  preferredDependency?: DependencySemantics;
  ctx: TypingContext;
}): boolean => {
  const resolved = resolveDependencySymbol({
    ownerModuleId,
    ownerSymbol,
    preferredDependency,
    ctx,
  });
  if (!resolved) {
    return false;
  }
  hydrateImportedTraitMetadataForDependencySymbol({
    dependency: resolved.dependency,
    dependencySymbol: resolved.dependencySymbol,
    ctx,
  });
  return true;
};

export const hydrateImportedTraitMetadataForNominal = ({
  nominal,
  ctx,
}: {
  nominal: TypeId;
  ctx: TypingContext;
}): boolean => {
  const nominalDesc = ctx.arena.get(nominal);
  if (nominalDesc.kind !== "nominal-object") {
    return false;
  }
  if (nominalDesc.owner.moduleId !== ctx.moduleId) {
    return hydrateImportedTraitMetadataForOwnerRef({
      ownerModuleId: nominalDesc.owner.moduleId,
      ownerSymbol: nominalDesc.owner.symbol,
      ctx,
    });
  }
  const localOwner = localSymbolForSymbolRef(nominalDesc.owner, ctx);
  if (typeof localOwner !== "number") {
    return false;
  }
  const target = importTargetFor(localOwner, ctx);
  if (!target) {
    return false;
  }
  const dependency = ctx.dependencies.get(target.moduleId);
  if (!dependency) {
    return false;
  }
  hydrateImportedTraitMetadataForDependencySymbol({
    dependency,
    dependencySymbol: target.symbol,
    ctx,
  });
  return true;
};
