import type { SymbolId } from "../ids.js";
import type { SymbolKind } from "../binder/index.js";
import { resolveImportedValue } from "./imports.js";
import type { TypingContext } from "./types.js";

const isImportedValueLikeKind = (kind: SymbolKind): boolean =>
  kind === "value" || kind === "effect-op";

const hasImportMetadata = (
  metadata: unknown,
): metadata is { import: unknown } =>
  typeof metadata === "object" &&
  metadata !== null &&
  "import" in metadata;

export const isImportedValueLikeSymbol = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: TypingContext;
}): boolean => {
  const record = ctx.symbolTable.getSymbol(symbol);
  if (!isImportedValueLikeKind(record.kind)) {
    return false;
  }
  return (
    Boolean(ctx.importsByLocal.get(symbol)) ||
    hasImportMetadata(record.metadata)
  );
};

export const hydrateImportedValueLikeSymbol = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: TypingContext;
}): ReturnType<typeof resolveImportedValue> | undefined => {
  if (!isImportedValueLikeSymbol({ symbol, ctx })) {
    return undefined;
  }
  return resolveImportedValue({ symbol, ctx });
};
