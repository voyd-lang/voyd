import type { BindingResult } from "./binding/binding.js";
import type { SymbolId } from "./ids.js";

type IntrinsicMetadata = {
  intrinsic?: boolean;
  intrinsicName?: string;
  intrinsicUsesSignature?: boolean;
};

const normalizeModuleId = (moduleId: string): string =>
  moduleId.replace(/\\/g, "/");

const FIXED_ARRAY_INTRINSICS = new Map<string, IntrinsicMetadata>([
  [
    "new_fixed_array",
    {
      intrinsic: true,
      intrinsicName: "__array_new",
      intrinsicUsesSignature: false,
    },
  ],
  [
    "get",
    {
      intrinsic: true,
      intrinsicName: "__array_get",
      intrinsicUsesSignature: true,
    },
  ],
  [
    "set",
    {
      intrinsic: true,
      intrinsicName: "__array_set",
      intrinsicUsesSignature: true,
    },
  ],
  [
    "copy",
    {
      intrinsic: true,
      intrinsicName: "__array_copy",
      intrinsicUsesSignature: true,
    },
  ],
  [
    "length",
    {
      intrinsic: true,
      intrinsicName: "__array_len",
      intrinsicUsesSignature: false,
    },
  ],
]);

const MODULE_INTRINSICS = new Map<string, Map<string, IntrinsicMetadata>>([
  [normalizeModuleId("packages/std_next/fixed_array.voyd"), FIXED_ARRAY_INTRINSICS],
  ["std::fixed_array", FIXED_ARRAY_INTRINSICS],
]);

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
