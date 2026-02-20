import type { SymbolId } from "../ids.js";
import type { TraitMethodImpl } from "./types.js";

export type TraitMethodMappingConflict = {
  implMethodSymbol: SymbolId;
  existing: TraitMethodImpl;
  incoming: TraitMethodImpl;
};

export const registerTraitMethodImplMapping = ({
  traitMethodImpls,
  implMethodSymbol,
  traitSymbol,
  traitMethodSymbol,
  buildConflictMessage,
}: {
  traitMethodImpls: Map<SymbolId, TraitMethodImpl>;
  implMethodSymbol: SymbolId;
  traitSymbol: SymbolId;
  traitMethodSymbol: SymbolId;
  buildConflictMessage: (conflict: TraitMethodMappingConflict) => string;
}): void => {
  const existing = traitMethodImpls.get(implMethodSymbol);
  const incoming: TraitMethodImpl = {
    traitSymbol,
    traitMethodSymbol,
  };
  if (existing) {
    if (
      existing.traitSymbol === traitSymbol &&
      existing.traitMethodSymbol === traitMethodSymbol
    ) {
      return;
    }
    throw new Error(
      buildConflictMessage({
        implMethodSymbol,
        existing,
        incoming,
      }),
    );
  }
  traitMethodImpls.set(implMethodSymbol, incoming);
};
