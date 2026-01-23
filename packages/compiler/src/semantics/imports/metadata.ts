import type { SymbolId } from "../ids.js";
import type { SymbolTable } from "../binder/index.js";

const IMPORTABLE_KEYS = [
  "entity",
  "intrinsic",
  "intrinsicName",
  "intrinsicUsesSignature",
  "intrinsicType",
  "serializer",
] as const;

type ImportableMetadata = Partial<
  Record<(typeof IMPORTABLE_KEYS)[number], unknown>
>;

export const importableMetadataFrom = (
  source?: Record<string, unknown>
): ImportableMetadata | undefined => {
  if (!source) {
    return undefined;
  }
  const picked: ImportableMetadata = {};
  IMPORTABLE_KEYS.forEach((key) => {
    if (source[key] !== undefined) {
      picked[key] = source[key];
    }
  });
  return Object.keys(picked).length > 0 ? picked : undefined;
};

export const applyImportableMetadata = ({
  symbolTable,
  symbol,
  source,
}: {
  symbolTable: Pick<SymbolTable, "setSymbolMetadata">;
  symbol: SymbolId;
  source?: Record<string, unknown>;
}): void => {
  const metadata = importableMetadataFrom(source);
  if (metadata) {
    symbolTable.setSymbolMetadata(symbol, metadata);
  }
};

export const importedModuleIdFrom = (
  source?: Record<string, unknown>
): string | undefined => {
  const meta = source as
    | { import?: { moduleId?: unknown } | undefined }
    | undefined;
  const moduleId = meta?.import?.moduleId;
  return typeof moduleId === "string" ? moduleId : undefined;
};
