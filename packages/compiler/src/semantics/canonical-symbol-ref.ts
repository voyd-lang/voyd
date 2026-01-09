import type { SymbolId } from "./ids.js";
import type { SymbolRef } from "./program-symbol-arena.js";

export type ImportTargetResolver = (ref: SymbolRef) => SymbolRef | undefined;

export const createCanonicalSymbolRefResolver = ({
  resolveImportTarget,
}: {
  resolveImportTarget: ImportTargetResolver;
}): ((ref: SymbolRef) => SymbolRef) => {
  return (ref) => {
    let current = ref;
    const visitedByModule = new Map<string, Set<SymbolId>>();

    while (true) {
      const next = resolveImportTarget(current);
      if (!next) {
        return current;
      }

      let visited = visitedByModule.get(current.moduleId);
      if (!visited) {
        visited = new Set();
        visitedByModule.set(current.moduleId, visited);
      }

      if (visited.has(current.symbol)) {
        return current;
      }
      visited.add(current.symbol);
      current = next;
    }
  };
};

