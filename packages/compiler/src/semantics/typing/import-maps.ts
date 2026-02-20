import type { SymbolId } from "../ids.js";

type ImportTarget = { moduleId: string; symbol: SymbolId };

export type ImportBindingEntry = {
  local: SymbolId;
  target?: ImportTarget;
};

export type ImportMaps = {
  importsByLocal: Map<SymbolId, ImportTarget>;
  importAliasesByModule: Map<string, Map<SymbolId, SymbolId>>;
};

export const createImportMaps = (
  entries: readonly ImportBindingEntry[] | undefined,
  options: {
    canonicalizeTarget?: (target: ImportTarget) => ImportTarget;
  } = {},
): ImportMaps => {
  const importsByLocal = new Map<SymbolId, ImportTarget>();
  const importAliasesByModule = new Map<string, Map<SymbolId, SymbolId>>();

  (entries ?? []).forEach((entry) => {
    if (!entry.target) {
      return;
    }
    const target = options.canonicalizeTarget
      ? options.canonicalizeTarget(entry.target)
      : entry.target;
    importsByLocal.set(entry.local, target);
    const bucket = importAliasesByModule.get(target.moduleId) ?? new Map();
    bucket.set(target.symbol, entry.local);
    importAliasesByModule.set(target.moduleId, bucket);
  });

  return { importsByLocal, importAliasesByModule };
};
