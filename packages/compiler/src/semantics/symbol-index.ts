import type { SymbolId } from "./ids.js";
import type { SymbolTable } from "./binder/index.js";

export type IntrinsicFunctionFlags = {
  intrinsic: boolean;
  intrinsicUsesSignature: boolean;
};

export type SerializerMetadata = {
  formatId: string;
  encode: { moduleId: string; symbol: SymbolId };
  decode: { moduleId: string; symbol: SymbolId };
};

export type ModuleSymbolIndex = {
  moduleId: string;
  packageId: string;
  getName(symbol: SymbolId): string | undefined;
  resolveTopLevel(name: string): SymbolId | undefined;
  isModuleScoped(symbol: SymbolId): boolean;
  getIntrinsicType(symbol: SymbolId): string | undefined;
  getIntrinsicName(symbol: SymbolId): string | undefined;
  getIntrinsicFunctionFlags(symbol: SymbolId): IntrinsicFunctionFlags;
  getSerializer(symbol: SymbolId): SerializerMetadata | undefined;
};

export const buildModuleSymbolIndex = ({
  moduleId,
  packageId,
  symbolTable,
}: {
  moduleId: string;
  packageId: string;
  symbolTable: SymbolTable;
}): ModuleSymbolIndex => {
  const nameBySymbol = new Map<SymbolId, string>();
  const topLevelByName = new Map<string, SymbolId>();
  const moduleScopedBySymbol = new Map<SymbolId, boolean>();
  const intrinsicTypeBySymbol = new Map<SymbolId, string>();
  const intrinsicNameBySymbol = new Map<SymbolId, string>();
  const intrinsicFlagsBySymbol = new Map<SymbolId, IntrinsicFunctionFlags>();
  const serializerBySymbol = new Map<SymbolId, SerializerMetadata>();

  const snapshot = symbolTable.snapshot();
  snapshot.symbols.forEach((record) => {
    if (!record) return;
    const symbol = record.id as SymbolId;
    nameBySymbol.set(symbol, record.name);
    moduleScopedBySymbol.set(symbol, symbolTable.getScope(record.scope).kind === "module");
    if (record.scope === symbolTable.rootScope && !topLevelByName.has(record.name)) {
      topLevelByName.set(record.name, symbol);
    }

    const metadata = (record.metadata ?? {}) as {
      intrinsicType?: unknown;
      intrinsicName?: unknown;
      intrinsic?: unknown;
      intrinsicUsesSignature?: unknown;
      serializer?: unknown;
    };

    if (typeof metadata.intrinsicType === "string") {
      intrinsicTypeBySymbol.set(symbol, metadata.intrinsicType);
    }
    if (typeof metadata.intrinsicName === "string") {
      intrinsicNameBySymbol.set(symbol, metadata.intrinsicName);
    }
    if (metadata.intrinsic === true || metadata.intrinsicUsesSignature === true) {
      intrinsicFlagsBySymbol.set(symbol, {
        intrinsic: metadata.intrinsic === true,
        intrinsicUsesSignature: metadata.intrinsicUsesSignature === true,
      });
    }
    if (isSerializerMetadata(metadata.serializer)) {
      serializerBySymbol.set(symbol, metadata.serializer);
    }
  });

  return {
    moduleId,
    packageId,
    getName: (symbol) => nameBySymbol.get(symbol),
    resolveTopLevel: (name) => topLevelByName.get(name),
    isModuleScoped: (symbol) => moduleScopedBySymbol.get(symbol) === true,
    getIntrinsicType: (symbol) => intrinsicTypeBySymbol.get(symbol),
    getIntrinsicName: (symbol) => intrinsicNameBySymbol.get(symbol),
    getIntrinsicFunctionFlags: (symbol) =>
      intrinsicFlagsBySymbol.get(symbol) ?? {
        intrinsic: false,
        intrinsicUsesSignature: false,
      },
    getSerializer: (symbol) => serializerBySymbol.get(symbol),
  };
};

const isSerializerMetadata = (value: unknown): value is SerializerMetadata => {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as {
    formatId?: unknown;
    encode?: { moduleId?: unknown; symbol?: unknown };
    decode?: { moduleId?: unknown; symbol?: unknown };
  };
  return (
    typeof record.formatId === "string" &&
    typeof record.encode?.moduleId === "string" &&
    typeof record.encode?.symbol === "number" &&
    typeof record.decode?.moduleId === "string" &&
    typeof record.decode?.symbol === "number"
  );
};
