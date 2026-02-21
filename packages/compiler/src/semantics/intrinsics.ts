export type IntrinsicValueMetadata = {
  intrinsicName?: string;
  intrinsicUsesSignature?: boolean;
  access?: "public" | "std-only";
};

export type IntrinsicTypeMetadata = Record<string, unknown>;

export const intrinsicValueMetadataFor = (
  name: string
): IntrinsicValueMetadata | undefined => VALUE_INTRINSICS.get(name);

export const intrinsicTypeMetadataFor = (
  name: string
): IntrinsicTypeMetadata | undefined => TYPE_INTRINSICS.get(name);

export const isStdOnlyIntrinsicName = (name: string): boolean => {
  if (name.startsWith("__")) {
    return true;
  }
  return VALUE_INTRINSICS.get(name)?.access === "std-only";
};

const VALUE_INTRINSICS = new Map<string, IntrinsicValueMetadata>([
  ["~", { intrinsicUsesSignature: false }],
  ["__array_new", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__array_new_fixed", { intrinsicUsesSignature: false, access: "std-only" }],
  [
    "fixed_array_literal",
    {
      intrinsicName: "__array_new_fixed",
      intrinsicUsesSignature: false,
    },
  ],
  ["__array_get", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__array_set", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__array_len", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__array_copy", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__ref_is_null", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__type_to_heap_type", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__memory_size", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__memory_grow", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__memory_load_u8", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__memory_store_u8", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__memory_load_u16", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__memory_store_u16", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__memory_load_u32", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__memory_store_u32", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__memory_copy", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__panic_trap", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__shift_l", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__shift_ru", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__bit_and", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__bit_or", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__bit_xor", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__i32_wrap_i64", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__i64_extend_u", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__i64_extend_s", { intrinsicUsesSignature: false, access: "std-only" }],
  [
    "__reinterpret_f32_to_i32",
    { intrinsicUsesSignature: false, access: "std-only" },
  ],
  [
    "__reinterpret_i32_to_f32",
    { intrinsicUsesSignature: false, access: "std-only" },
  ],
  ["__f32_demote_f64", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__f64_promote_f32", { intrinsicUsesSignature: false, access: "std-only" }],
  ["__floor", { access: "std-only" }],
  ["__ceil", { access: "std-only" }],
  ["__round", { access: "std-only" }],
  ["__trunc", { access: "std-only" }],
  ["__sqrt", { access: "std-only" }],
  [
    "__reinterpret_f64_to_i64",
    { intrinsicUsesSignature: false, access: "std-only" },
  ],
  [
    "__reinterpret_i64_to_f64",
    { intrinsicUsesSignature: false, access: "std-only" },
  ],
  ["+", {}],
  ["-", {}],
  ["*", {}],
  ["/", {}],
  ["%", {}],
  ["<", {}],
  ["<=", {}],
  [">", {}],
  [">=", {}],
  ["==", {}],
  ["!=", {}],
  ["and", {}],
  ["or", {}],
  ["xor", {}],
  ["not", {}],
]);

const TYPE_INTRINSICS = new Map<string, IntrinsicTypeMetadata>([
  ["FixedArray", { intrinsic: true, intrinsicType: "fixed-array", arity: 1 }],
]);
