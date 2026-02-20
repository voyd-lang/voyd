import type { SymbolId } from "../ids.js";
import type { SymbolTable } from "../binder/index.js";
import type { SymbolRefKey, TypingContext } from "./types.js";
import type { SymbolRef } from "./symbol-ref.js";

type ImportMetadata = {
  import?: { moduleId?: unknown; symbol?: unknown };
};

export const importTargetFromSymbolTable = (
  symbol: SymbolId,
  symbolTable: SymbolTable,
): SymbolRef | undefined => {
  try {
    const metadata = (symbolTable.getSymbol(symbol).metadata ?? {}) as
      | ImportMetadata
      | undefined;
    const importModuleId = metadata?.import?.moduleId;
    const importSymbol = metadata?.import?.symbol;
    if (
      typeof importModuleId === "string" &&
      typeof importSymbol === "number"
    ) {
      return { moduleId: importModuleId, symbol: importSymbol };
    }
  } catch {
    return undefined;
  }
  return undefined;
};

export const createImportTargetResolver = ({
  moduleId,
  symbolTable,
  dependencies,
}: {
  moduleId: string;
  symbolTable: SymbolTable;
  dependencies: ReadonlyMap<string, { symbolTable: SymbolTable }>;
}): ((ref: SymbolRef) => SymbolRef | undefined) => {
  return (ref) => {
    const sourceTable = ref.moduleId === moduleId
      ? symbolTable
      : dependencies.get(ref.moduleId)?.symbolTable;
    if (!sourceTable) {
      return undefined;
    }
    return importTargetFromSymbolTable(ref.symbol, sourceTable);
  };
};
export const canonicalizeSymbolRef = ({
  ref,
  resolveImportTarget,
}: {
  ref: SymbolRef;
  resolveImportTarget: (ref: SymbolRef) => SymbolRef | undefined;
}): SymbolRef => {
  let current = ref;
  const seen = new Set<string>();

  while (true) {
    const key = `${current.moduleId}::${current.symbol}`;
    if (seen.has(key)) {
      return current;
    }
    seen.add(key);

    const next = resolveImportTarget(current);
    if (!next) {
      return current;
    }
    current = next;
  }
};

export const canonicalSymbolRef = ({
  symbol,
  symbolTable,
  moduleId,
}: {
  symbol: SymbolId;
  symbolTable: SymbolTable;
  moduleId: string;
}): SymbolRef => {
  return canonicalizeSymbolRef({
    ref: { moduleId, symbol },
    resolveImportTarget: (ref) => {
      if (ref.moduleId !== moduleId) {
        return undefined;
      }
      return importTargetFromSymbolTable(ref.symbol, symbolTable);
    },
  });
};

export const canonicalSymbolRefForTypingContext = (
  symbol: SymbolId,
  ctx: TypingContext
): SymbolRef =>
  canonicalSymbolRefInTypingContext(
    { moduleId: ctx.moduleId, symbol },
    ctx,
  );

export const canonicalSymbolRefInTypingContext = (
  ref: SymbolRef,
  ctx: TypingContext,
): SymbolRef =>
  canonicalizeSymbolRef({
    ref,
    resolveImportTarget: createImportTargetResolver({
      moduleId: ctx.moduleId,
      symbolTable: ctx.symbolTable,
      dependencies: ctx.dependencies,
    }),
  });

export const symbolRefKey = (ref: SymbolRef): SymbolRefKey =>
  `${ref.moduleId}::${ref.symbol}`;

export const parseSymbolRefKey = (key: SymbolRefKey): SymbolRef | undefined => {
  const delimiter = key.lastIndexOf("::");
  if (delimiter < 0) {
    return undefined;
  }
  const moduleId = key.slice(0, delimiter);
  const symbolText = key.slice(delimiter + 2);
  const symbol = Number(symbolText);
  if (!Number.isInteger(symbol)) {
    return undefined;
  }
  return { moduleId, symbol };
};

export const localSymbolForSymbolRef = (
  ref: SymbolRef,
  ctx: TypingContext
): SymbolId | undefined => {
  if (ref.moduleId === ctx.moduleId) {
    return ref.symbol;
  }

  const canonicalRef = canonicalSymbolRefInTypingContext(ref, ctx);
  if (canonicalRef.moduleId === ctx.moduleId) {
    return canonicalRef.symbol;
  }
  const bucket = ctx.importAliasesByModule.get(canonicalRef.moduleId);
  const alias = bucket?.get(canonicalRef.symbol);
  if (typeof alias === "number") {
    return alias;
  }

  if (
    canonicalRef.moduleId === ref.moduleId &&
    canonicalRef.symbol === ref.symbol
  ) {
    return undefined;
  }

  return ctx.importAliasesByModule.get(ref.moduleId)?.get(ref.symbol);
};
