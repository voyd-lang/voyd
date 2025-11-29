import type { BindingResult } from "./binding/binding.js";
import type { SymbolId } from "./ids.js";

type IntrinsicMetadata = {
  intrinsic?: boolean;
  intrinsicName?: string;
  intrinsicUsesSignature?: boolean;
};

const MODULE_INTRINSICS = new Map<string, Map<string, IntrinsicMetadata>>();
const normalizeModuleId = (moduleId: string): string =>
  moduleId.replace(/\\/g, "/");

export const tagIntrinsicSymbols = ({
  binding,
  moduleId,
}: {
  binding: BindingResult;
  moduleId: string;
}): void => {
  const moduleIntrinsics = MODULE_INTRINSICS.get(normalizeModuleId(moduleId));
  if (!moduleIntrinsics) {
    return;
  }

  binding.functions.forEach((fn) => {
    const metadata = moduleIntrinsics.get(fn.name);
    if (!metadata) {
      return;
    }
    setIntrinsicMetadata(fn.symbol, metadata, binding.symbolTable);
  });
};

const setIntrinsicMetadata = (
  symbol: SymbolId,
  metadata: IntrinsicMetadata,
  table: BindingResult["symbolTable"]
): void => {
  table.setSymbolMetadata(symbol, {
    intrinsic: true,
    ...metadata,
  });
};
