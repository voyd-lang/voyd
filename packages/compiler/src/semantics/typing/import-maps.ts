import type { SymbolId } from "../ids.js";

export type ImportBindingEntry = {
  local: SymbolId;
  target?: { moduleId: string; symbol: SymbolId };
};

export type ImportMaps = {
  importsByLocal: Map<SymbolId, { moduleId: string; symbol: SymbolId }>;
  importAliasesByModule: Map<string, Map<SymbolId, SymbolId>>;
};

export const createImportMaps = (
  entries: readonly ImportBindingEntry[] | undefined,
): ImportMaps => {
  const importsByLocal = new Map<SymbolId, { moduleId: string; symbol: SymbolId }>();
  const importAliasesByModule = new Map<string, Map<SymbolId, SymbolId>>();

  (entries ?? []).forEach((entry) => {
    if (!entry.target) {
      return;
    }
    importsByLocal.set(entry.local, entry.target);
    const bucket = importAliasesByModule.get(entry.target.moduleId) ?? new Map();
    bucket.set(entry.target.symbol, entry.local);
    importAliasesByModule.set(entry.target.moduleId, bucket);
  });

  return { importsByLocal, importAliasesByModule };
};
