import type { BindingResult } from "./binding/binding.js";
import type { SymbolId } from "./ids.js";

type IntrinsicMetadata = {
  intrinsic?: boolean;
  intrinsicName?: string;
  intrinsicUsesSignature?: boolean;
};

const FIXED_ARRAY_INTRINSICS = new Map<string, IntrinsicMetadata>([
  ["new_fixed_array", { intrinsicName: "__array_new", intrinsicUsesSignature: false }],
  ["get", { intrinsicName: "__array_get", intrinsicUsesSignature: false }],
  ["set", { intrinsicName: "__array_set", intrinsicUsesSignature: false }],
  ["copy", { intrinsicName: "__array_copy", intrinsicUsesSignature: false }],
  ["length", { intrinsicName: "__array_len", intrinsicUsesSignature: false }],
]);

const isFixedArrayModule = (moduleId: string): boolean =>
  moduleId.includes("std_next/fixed_array.voyd");

export const tagIntrinsicSymbols = ({
  binding,
  moduleId,
}: {
  binding: BindingResult;
  moduleId: string;
}): void => {
  if (!isFixedArrayModule(moduleId)) {
    return;
  }

  binding.functions.forEach((fn) => {
    const metadata = FIXED_ARRAY_INTRINSICS.get(fn.name);
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
