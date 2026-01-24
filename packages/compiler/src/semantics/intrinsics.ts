export type IntrinsicValueMetadata = {
  intrinsicName?: string;
  intrinsicUsesSignature?: boolean;
};

export type IntrinsicTypeMetadata = Record<string, unknown>;

export const intrinsicValueMetadataFor = (
  name: string
): IntrinsicValueMetadata | undefined => VALUE_INTRINSICS.get(name);

export const intrinsicTypeMetadataFor = (
  name: string
): IntrinsicTypeMetadata | undefined => TYPE_INTRINSICS.get(name);

const VALUE_INTRINSICS = new Map<string, IntrinsicValueMetadata>([
  ["~", { intrinsicUsesSignature: false }],
  ["__array_new", { intrinsicUsesSignature: false }],
  ["__array_new_fixed", { intrinsicUsesSignature: false }],
  [
    "fixed_array_literal",
    { intrinsicName: "__array_new_fixed", intrinsicUsesSignature: false },
  ],
  ["__array_get", { intrinsicUsesSignature: false }],
  ["__array_set", { intrinsicUsesSignature: false }],
  ["__array_len", { intrinsicUsesSignature: false }],
  ["__array_copy", { intrinsicUsesSignature: false }],
  ["__memory_size", { intrinsicUsesSignature: false }],
  ["__memory_grow", { intrinsicUsesSignature: false }],
  ["__memory_load_u8", { intrinsicUsesSignature: false }],
  ["__memory_store_u8", { intrinsicUsesSignature: false }],
  ["__memory_load_u16", { intrinsicUsesSignature: false }],
  ["__memory_store_u16", { intrinsicUsesSignature: false }],
  ["__memory_load_u32", { intrinsicUsesSignature: false }],
  ["__memory_store_u32", { intrinsicUsesSignature: false }],
  ["__memory_copy", { intrinsicUsesSignature: false }],
  ["__shift_l", { intrinsicUsesSignature: false }],
  ["__shift_ru", { intrinsicUsesSignature: false }],
  ["__bit_and", { intrinsicUsesSignature: false }],
  ["__bit_or", { intrinsicUsesSignature: false }],
  ["__bit_xor", { intrinsicUsesSignature: false }],
  ["__i32_wrap_i64", { intrinsicUsesSignature: false }],
  ["__i64_extend_u", { intrinsicUsesSignature: false }],
  ["__i64_extend_s", { intrinsicUsesSignature: false }],
  ["__reinterpret_f32_to_i32", { intrinsicUsesSignature: false }],
  ["__reinterpret_i32_to_f32", { intrinsicUsesSignature: false }],
  ["__f32_demote_f64", { intrinsicUsesSignature: false }],
  ["__f64_promote_f32", { intrinsicUsesSignature: false }],
  ["__reinterpret_f64_to_i64", { intrinsicUsesSignature: false }],
  ["__reinterpret_i64_to_f64", { intrinsicUsesSignature: false }],
  ["+", {}],
  ["-", {}],
  ["*", {}],
  ["/", {}],
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
