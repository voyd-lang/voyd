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
