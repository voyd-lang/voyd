import type { SymbolId } from "../ids.js";
import type { SymbolTable } from "../binder/index.js";
import type { TypingContext } from "./types.js";
import type { SymbolRef } from "./symbol-ref.js";

export const canonicalSymbolRef = ({
  symbol,
  symbolTable,
  moduleId,
}: {
  symbol: SymbolId;
  symbolTable: SymbolTable;
  moduleId: string;
}): SymbolRef => {
  const metadata = (symbolTable.getSymbol(symbol).metadata ?? {}) as
    | { import?: { moduleId?: unknown; symbol?: unknown } }
    | undefined;
  const importModuleId = metadata?.import?.moduleId;
  const importSymbol = metadata?.import?.symbol;
  if (typeof importModuleId === "string" && typeof importSymbol === "number") {
    return { moduleId: importModuleId, symbol: importSymbol };
  }
  return { moduleId, symbol };
};

export const canonicalSymbolRefForTypingContext = (
  symbol: SymbolId,
  ctx: TypingContext
): SymbolRef => canonicalSymbolRef({ symbol, symbolTable: ctx.symbolTable, moduleId: ctx.moduleId });

export const localSymbolForSymbolRef = (
  ref: SymbolRef,
  ctx: TypingContext
): SymbolId | undefined => {
  if (ref.moduleId === ctx.moduleId) {
    return ref.symbol;
  }
  const bucket = ctx.importAliasesByModule.get(ref.moduleId);
  return bucket?.get(ref.symbol);
};

