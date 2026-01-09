import { describe, expect, it } from "vitest";

import type { SymbolId } from "../ids.js";
import { createCanonicalSymbolRefResolver } from "../canonical-symbol-ref.js";

const sym = (value: number) => value as SymbolId;

describe("canonical symbol ref", () => {
  it("chases through import targets to the final symbol", () => {
    const targetsByModule = new Map<string, Map<SymbolId, { moduleId: string; symbol: SymbolId }>>([
      ["a", new Map([[sym(1), { moduleId: "b", symbol: sym(2) }]])],
      ["b", new Map([[sym(2), { moduleId: "c", symbol: sym(3) }]])],
    ]);

    const resolveImportTarget = (ref: { moduleId: string; symbol: SymbolId }) =>
      targetsByModule.get(ref.moduleId)?.get(ref.symbol);

    const canonicalSymbolRef = createCanonicalSymbolRefResolver({ resolveImportTarget });

    expect(canonicalSymbolRef({ moduleId: "a", symbol: sym(1) })).toEqual({
      moduleId: "c",
      symbol: sym(3),
    });
  });

  it("returns the original ref when there is no import target", () => {
    const targetsByModule = new Map<string, Map<SymbolId, { moduleId: string; symbol: SymbolId }>>();
    const resolveImportTarget = (ref: { moduleId: string; symbol: SymbolId }) =>
      targetsByModule.get(ref.moduleId)?.get(ref.symbol);

    const canonicalSymbolRef = createCanonicalSymbolRefResolver({ resolveImportTarget });

    expect(canonicalSymbolRef({ moduleId: "a", symbol: sym(1) })).toEqual({
      moduleId: "a",
      symbol: sym(1),
    });
  });

  it("halts when an import cycle is detected", () => {
    const targetsByModule = new Map<string, Map<SymbolId, { moduleId: string; symbol: SymbolId }>>([
      ["a", new Map([[sym(1), { moduleId: "b", symbol: sym(2) }]])],
      ["b", new Map([[sym(2), { moduleId: "a", symbol: sym(1) }]])],
    ]);

    const resolveImportTarget = (ref: { moduleId: string; symbol: SymbolId }) =>
      targetsByModule.get(ref.moduleId)?.get(ref.symbol);

    const canonicalSymbolRef = createCanonicalSymbolRefResolver({ resolveImportTarget });

    expect(canonicalSymbolRef({ moduleId: "a", symbol: sym(1) })).toEqual({
      moduleId: "a",
      symbol: sym(1),
    });
  });
});

