import type { CodegenContext, SymbolId } from "./context.js";

export const wasmSymbolName = ({
  ctx,
  moduleId,
  symbol,
}: {
  ctx: CodegenContext;
  moduleId: string;
  symbol: SymbolId;
}): string => {
  const id = ctx.program.symbols.idOf({ moduleId, symbol });
  return ctx.program.symbols.isFresh(id)
    ? `hygienic_${symbol}`
    : (ctx.program.symbols.getName(id) ?? `${symbol}`);
};

export const sanitizeWasmIdentifier = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

export const sanitizedWasmSymbolName = (
  options: Parameters<typeof wasmSymbolName>[0],
): string => sanitizeWasmIdentifier(wasmSymbolName(options));
