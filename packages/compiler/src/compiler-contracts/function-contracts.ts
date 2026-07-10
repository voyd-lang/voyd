export const BOUNDARY_MSGPACK_CONTRACT_IDS = {
  encodeValue: "voyd.std.boundary.msgpack.encode-value",
  decodeValue: "voyd.std.boundary.msgpack.decode-value",
  makeNull: "voyd.std.boundary.msgpack.make-null",
  makeBool: "voyd.std.boundary.msgpack.make-bool",
  makeString: "voyd.std.boundary.msgpack.make-string",
  makeArray: "voyd.std.boundary.msgpack.make-array",
  makeI32: "voyd.std.boundary.msgpack.make-i32",
  makeI64: "voyd.std.boundary.msgpack.make-i64",
  makeF32: "voyd.std.boundary.msgpack.make-f32",
  makeF64: "voyd.std.boundary.msgpack.make-f64",
  makeMap: "voyd.std.boundary.msgpack.make-map",
  unpackBool: "voyd.std.boundary.msgpack.unpack-bool",
  unpackString: "voyd.std.boundary.msgpack.unpack-string",
  unpackArray: "voyd.std.boundary.msgpack.unpack-array",
  unpackI32: "voyd.std.boundary.msgpack.unpack-i32",
  unpackI64: "voyd.std.boundary.msgpack.unpack-i64",
  unpackF32: "voyd.std.boundary.msgpack.unpack-f32",
  unpackF64: "voyd.std.boundary.msgpack.unpack-f64",
  unpackMap: "voyd.std.boundary.msgpack.unpack-map",
  arrayWithCapacity: "voyd.std.boundary.msgpack.array-with-capacity",
  arrayPush: "voyd.std.boundary.msgpack.array-push",
  arrayLength: "voyd.std.boundary.msgpack.array-length",
  arrayRawStorage: "voyd.std.boundary.msgpack.array-raw-storage",
  mapNew: "voyd.std.boundary.msgpack.map-new",
  mapSet: "voyd.std.boundary.msgpack.map-set",
  mapGet: "voyd.std.boundary.msgpack.map-get",
  mapHas: "voyd.std.boundary.msgpack.map-has",
  mapTagIs: "voyd.std.boundary.msgpack.map-tag-is",
  newString: "voyd.std.boundary.msgpack.string-new",
} as const;

export type CompilerFunctionContractId =
  (typeof BOUNDARY_MSGPACK_CONTRACT_IDS)[keyof typeof BOUNDARY_MSGPACK_CONTRACT_IDS];

/**
 * Loader bootstrap for synthetic entry modules that need every provider in the
 * graph before contract metadata can be indexed. Consumers must resolve roles
 * by ID after loading; these paths are not codegen identities.
 */
export const BOUNDARY_MSGPACK_CONTRACT_PROVIDER_MODULES = [
  "std::msgpack",
  "std::msgpack::fns",
  "std::string",
] as const;

export type CompilerContractFeature = "boundary-msgpack";

export type CompilerContractPrimitiveType =
  | "bool"
  | "i32"
  | "i64"
  | "f32"
  | "f64";

export type CompilerContractSharedType =
  | "msgpack"
  | "string"
  | "msgpack-array"
  | "msgpack-map";

/** Symbolic types are resolved relationally after typing, at feature use. */
export type CompilerContractTypeSpec =
  | { readonly kind: "primitive"; readonly name: CompilerContractPrimitiveType }
  | { readonly kind: "shared"; readonly name: CompilerContractSharedType }
  | { readonly kind: "fixed-array"; readonly element: CompilerContractTypeSpec };

export type CompilerFunctionContractSignatureSpec = {
  readonly typeParameters: 0;
  readonly parameters: readonly {
    readonly type: CompilerContractTypeSpec;
    readonly optional: false;
  }[];
  readonly result: CompilerContractTypeSpec;
  readonly effect: "pure";
};

export type CompilerFunctionContractSpec = {
  readonly id: CompilerFunctionContractId;
  readonly feature: CompilerContractFeature;
  readonly expectedArity: number;
  readonly signature: CompilerFunctionContractSignatureSpec;
};

const primitive = (name: CompilerContractPrimitiveType): CompilerContractTypeSpec =>
  ({ kind: "primitive", name });
const shared = (name: CompilerContractSharedType): CompilerContractTypeSpec =>
  ({ kind: "shared", name });
const fixedArray = (element: CompilerContractTypeSpec): CompilerContractTypeSpec =>
  ({ kind: "fixed-array", element });

const type = {
  bool: primitive("bool"), i32: primitive("i32"), i64: primitive("i64"),
  f32: primitive("f32"), f64: primitive("f64"),
  msgpack: shared("msgpack"), string: shared("string"),
  array: shared("msgpack-array"), map: shared("msgpack-map"),
} as const;

const contract = (
  id: CompilerFunctionContractId,
  parameters: readonly CompilerContractTypeSpec[],
  result: CompilerContractTypeSpec,
): CompilerFunctionContractSpec => ({
  id,
  feature: "boundary-msgpack",
  expectedArity: parameters.length,
  signature: {
    typeParameters: 0,
    parameters: parameters.map((parameterType) => ({
      type: parameterType,
      optional: false,
    })),
    result,
    effect: "pure",
  },
});

const boundaryMsgpackContractSpecs: readonly CompilerFunctionContractSpec[] = [
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.encodeValue, [type.msgpack, type.i32, type.i32], type.i32),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.decodeValue, [type.i32, type.i32], type.msgpack),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.makeNull, [], type.msgpack),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.makeBool, [type.bool], type.msgpack),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.makeString, [type.string], type.msgpack),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.makeArray, [type.array], type.msgpack),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.makeI32, [type.i32], type.msgpack),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.makeI64, [type.i64], type.msgpack),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.makeF32, [type.f32], type.msgpack),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.makeF64, [type.f64], type.msgpack),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.makeMap, [type.map], type.msgpack),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.unpackBool, [type.msgpack], type.bool),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.unpackString, [type.msgpack], type.string),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.unpackArray, [type.msgpack], type.array),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.unpackI32, [type.msgpack], type.i32),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.unpackI64, [type.msgpack], type.i64),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.unpackF32, [type.msgpack], type.f32),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.unpackF64, [type.msgpack], type.f64),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.unpackMap, [type.msgpack], type.map),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.arrayWithCapacity, [type.i32], type.array),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.arrayPush, [type.array, type.msgpack], type.array),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.arrayLength, [type.array], type.i32),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.arrayRawStorage, [type.array], fixedArray(type.msgpack)),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.mapNew, [], type.map),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.mapSet, [type.map, type.string, type.msgpack], type.map),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.mapGet, [type.map, type.string], type.msgpack),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.mapHas, [type.map, type.string], type.bool),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.mapTagIs, [type.map, type.string], type.bool),
  contract(BOUNDARY_MSGPACK_CONTRACT_IDS.newString, [fixedArray(type.i32)], type.string),
];

export const COMPILER_FUNCTION_CONTRACTS: ReadonlyMap<
  CompilerFunctionContractId,
  CompilerFunctionContractSpec
> = new Map(
  boundaryMsgpackContractSpecs.map((spec) => [spec.id, spec]),
);

export const getCompilerFunctionContractSpec = (
  id: string,
): CompilerFunctionContractSpec | undefined =>
  COMPILER_FUNCTION_CONTRACTS.get(id as CompilerFunctionContractId);

export const isCompilerFunctionContractId = (
  id: string,
): id is CompilerFunctionContractId =>
  COMPILER_FUNCTION_CONTRACTS.has(id as CompilerFunctionContractId);
