import type { SymbolTable } from "../binder/index.js";
import type { HirGraph } from "../hir/index.js";
import type { SymbolId, TypeId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type { PlaceProjection } from "./model.js";
import { namedRegionPlacePath } from "./named-contracts.js";
import type { BorrowingDependency } from "./dependency.js";

export type TraitRegionProjection = {
  source: readonly PlaceProjection[];
  result: PlaceProjection;
};

export type LocalTraitRegionProjection = TraitRegionProjection & {
  concrete: SymbolRef;
  trait: SymbolRef;
  implementation: SymbolRef;
  implementationMethods: readonly SymbolId[];
};

export type ResolvedTraitRegionProjection = TraitRegionProjection & {
  concrete: SymbolRef;
  trait: SymbolRef;
  implementation: SymbolRef;
};

export const localTraitRegionProjectionMetadata = ({
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
}: {
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
}): readonly LocalTraitRegionProjection[] => {
  const symbolRefFor = (symbol: SymbolId): SymbolRef =>
    imports.get(symbol) ?? { moduleId, symbol };
  return Array.from(hir.items.values()).flatMap((item) => {
    if (
      item.kind !== "impl" ||
      item.target.typeKind !== "named" ||
      typeof item.target.symbol !== "number" ||
      item.trait?.typeKind !== "named" ||
      typeof item.trait.symbol !== "number"
    ) {
      return [];
    }
    const targetSymbol = item.target.symbol;
    const traitSymbol = item.trait.symbol;
    const trait = typing.traits.getDecl(traitSymbol);
    if (!trait) {
      return [];
    }
    const traitRef = symbolRefFor(traitSymbol);
    const traitDescriptor =
      typeof item.trait.typeId === "number"
        ? typing.arena.get(item.trait.typeId)
        : undefined;
    const traitName =
      traitDescriptor?.kind === "trait"
        ? traitDescriptor.name
        : symbolTable.getSymbol(traitSymbol).name;
    const disjointFor = (name: string): readonly string[] =>
      (trait.disjoint ?? []).flatMap((declaration) =>
        declaration.regions.includes(name)
          ? declaration.regions.filter((candidate) => candidate !== name)
          : [],
      );
    const implementationMethods = item.members.flatMap((member) => {
      const implementation = hir.items.get(member);
      return implementation?.kind === "function" ? [implementation.symbol] : [];
    });
    return (item.regionMappings ?? []).flatMap((mapping) =>
      mapping.place
        ? [
            {
              concrete: symbolRefFor(targetSymbol),
              trait: traitRef,
              implementation: symbolRefFor(item.symbol),
              implementationMethods,
              source: namedRegionPlacePath(mapping.place),
              result: {
                kind: "region" as const,
                scope: `${traitRef.moduleId}::${traitName}`,
                name: mapping.name,
                disjoint: disjointFor(mapping.name),
              },
            },
          ]
        : [],
    );
  });
};

export const resolvedTraitRegionProjectionsForCoercion = ({
  sourceType,
  targetType,
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
}: {
  sourceType: TypeId | undefined;
  targetType: TypeId | undefined;
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: ReadonlyMap<SymbolId, SymbolRef>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
}): readonly ResolvedTraitRegionProjection[] => {
  const nominalType = nominalComponent(sourceType, typing);
  if (typeof nominalType !== "number") {
    return [];
  }
  const nominal = typing.arena.get(nominalType);
  if (nominal.kind !== "nominal-object") {
    return [];
  }
  const targetTraits = traitComponents(targetType, typing);
  if (targetTraits.length === 0) {
    return [];
  }
  const canonicalSymbolRef = (symbol: SymbolId): SymbolRef => {
    const imported = imports.get(symbol);
    if (imported) {
      return imported;
    }
    const metadata = (symbolTable.getSymbol(symbol).metadata ?? {}) as {
      import?: { moduleId?: unknown; symbol?: unknown };
    };
    return typeof metadata.import?.moduleId === "string" &&
      typeof metadata.import.symbol === "number"
      ? {
          moduleId: metadata.import.moduleId,
          symbol: metadata.import.symbol,
        }
      : { moduleId, symbol };
  };
  const selectedImplementations = new Set(
    (
      typing.traitImplsByNominal.get(nominalType) ??
      (typeof sourceType === "number"
        ? typing.traitImplsByNominal.get(sourceType)
        : undefined) ??
      []
    )
      .filter((implementation) => targetTraits.includes(implementation.trait))
      .map((implementation) =>
        JSON.stringify(canonicalSymbolRef(implementation.implSymbol)),
      ),
  );
  if (selectedImplementations.size === 0) {
    return [];
  }
  const implementationWasSelected = (implementation: SymbolRef): boolean =>
    selectedImplementations.has(JSON.stringify(implementation));
  const local = localTraitRegionProjectionMetadata({
    hir,
    typing,
    symbolTable,
    moduleId,
    imports,
  }).filter(
    (projection) =>
      projection.concrete.moduleId === nominal.owner.moduleId &&
      projection.concrete.symbol === nominal.owner.symbol &&
      implementationWasSelected(projection.implementation),
  );
  const targetTraitOwners = new Set(
    targetTraits.flatMap((type) => {
      const descriptor = typing.arena.get(type);
      return descriptor.kind === "trait"
        ? [`${descriptor.owner.moduleId}:${descriptor.owner.symbol}`]
        : [];
    }),
  );
  const external = Array.from(dependencies.values()).flatMap((dependency) =>
    dependency.traitRegionProjections.filter(
      (projection) =>
        projection.concrete.moduleId === nominal.owner.moduleId &&
        projection.concrete.symbol === nominal.owner.symbol &&
        implementationWasSelected(projection.implementation) &&
        targetTraitOwners.has(
          `${projection.trait.moduleId}:${projection.trait.symbol}`,
        ),
    ),
  );
  const projections = [
    ...local
      .filter((projection) =>
        targetTraitOwners.has(
          `${projection.trait.moduleId}:${projection.trait.symbol}`,
        ),
      )
      .map(({ concrete, trait, implementation, source, result }) => ({
        concrete,
        trait,
        implementation,
        source,
        result,
      })),
    ...external.map(({ concrete, trait, implementation, source, result }) => ({
      concrete,
      trait,
      implementation,
      source,
      result,
    })),
  ];
  return Array.from(
    new Map(
      projections.map((projection) => [JSON.stringify(projection), projection]),
    ).values(),
  );
};

export const traitRegionProjectionsForCoercion = (
  args: Parameters<typeof resolvedTraitRegionProjectionsForCoercion>[0],
): readonly TraitRegionProjection[] =>
  resolvedTraitRegionProjectionsForCoercion(args).map(({ source, result }) => ({
    source,
    result,
  }));

const nominalComponent = (
  type: TypeId | undefined,
  typing: TypingResult,
): TypeId | undefined => {
  if (typeof type !== "number") {
    return undefined;
  }
  const descriptor = typing.arena.get(type);
  if (descriptor.kind === "nominal-object") {
    return type;
  }
  return descriptor.kind === "intersection" ? descriptor.nominal : undefined;
};

const traitComponents = (
  type: TypeId | undefined,
  typing: TypingResult,
  active = new Set<TypeId>(),
): readonly TypeId[] => {
  if (typeof type !== "number" || active.has(type)) {
    return [];
  }
  active.add(type);
  const descriptor = typing.arena.get(type);
  if (descriptor.kind === "trait") {
    return [type];
  }
  if (descriptor.kind === "intersection") {
    return descriptor.traits ?? [];
  }
  if (descriptor.kind === "union") {
    return descriptor.members.flatMap((member) =>
      traitComponents(member, typing, new Set(active)),
    );
  }
  if (descriptor.kind === "recursive") {
    return traitComponents(descriptor.body, typing, active);
  }
  return [];
};
