import type { SymbolId } from "../ids.js";

export type SymbolRef = {
  moduleId: string;
  symbol: SymbolId;
};

export const symbolRefEquals = (a: SymbolRef, b: SymbolRef): boolean =>
  a.moduleId === b.moduleId && a.symbol === b.symbol;

export const symbolRefKey = (ref: SymbolRef): string =>
  `${ref.moduleId}::${ref.symbol}`;

