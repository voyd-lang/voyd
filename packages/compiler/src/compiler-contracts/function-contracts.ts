export const MSGPACK_HOST_TRANSPORT_CONTRACT_IDS = {
  createReader: "voyd.std.host-transport.msgpack.create-reader",
  readerComplete: "voyd.std.host-transport.msgpack.reader-complete",
  createWriter: "voyd.std.host-transport.msgpack.create-writer",
  finishWriter: "voyd.std.host-transport.msgpack.finish-writer",
} as const;

export const DTO_DATA_CONTRACT_IDS = {
  cycleError: "voyd.std.data.cycle-error",
  makeNull: "voyd.std.data.make-null",
  makeBool: "voyd.std.data.make-bool",
  makeString: "voyd.std.data.make-string",
  makeBytes: "voyd.std.data.make-bytes",
  makeArray: "voyd.std.data.make-array",
  makeI32: "voyd.std.data.make-i32",
  makeI64: "voyd.std.data.make-i64",
  makeF32: "voyd.std.data.make-f32",
  makeF64: "voyd.std.data.make-f64",
  makeMap: "voyd.std.data.make-map",
  unpackBool: "voyd.std.data.unpack-bool",
  unpackString: "voyd.std.data.unpack-string",
  unpackBytes: "voyd.std.data.unpack-bytes",
  unpackArray: "voyd.std.data.unpack-array",
  unpackI32: "voyd.std.data.unpack-i32",
  unpackI64: "voyd.std.data.unpack-i64",
  unpackF32: "voyd.std.data.unpack-f32",
  unpackF64: "voyd.std.data.unpack-f64",
  unpackMap: "voyd.std.data.unpack-map",
  arrayWithCapacity: "voyd.std.data.array-with-capacity",
  arrayPush: "voyd.std.data.array-push",
  arrayLength: "voyd.std.data.array-length",
  arrayRawStorage: "voyd.std.data.array-raw-storage",
  mapNew: "voyd.std.data.map-new",
  mapSet: "voyd.std.data.map-set",
  mapGet: "voyd.std.data.map-get",
  mapHas: "voyd.std.data.map-has",
  mapTagIs: "voyd.std.data.map-tag-is",
  newString: "voyd.std.data.string-new",
} as const;

export const WEB_RENDER_CONTRACT_IDS = {
  typedRender: "voyd.web.render-generic",
  typedDocument: "voyd.web.document-generic",
  typedHydratedDocument: "voyd.web.document-hydrated-generic",
  typedNamedHydratedDocument: "voyd.web.hydrated-document-generic",
  typedHtmlResponse: "voyd.web.html-response-generic",
  typedHydratedHtmlResponse: "voyd.web.html-response-hydrated-generic",
  typedNamedHydratedHtmlResponse: "voyd.web.hydrated-html-response-generic",
  responseHtml: "voyd.web.response-html-generic",
  hydratedResponseHtml: "voyd.web.hydrated-response-html-generic",
} as const;

export type CompilerFunctionContractId =
  | (typeof MSGPACK_HOST_TRANSPORT_CONTRACT_IDS)[keyof typeof MSGPACK_HOST_TRANSPORT_CONTRACT_IDS]
  | (typeof DTO_DATA_CONTRACT_IDS)[keyof typeof DTO_DATA_CONTRACT_IDS]
  | (typeof WEB_RENDER_CONTRACT_IDS)[keyof typeof WEB_RENDER_CONTRACT_IDS];

/**
 * Loader bootstrap for synthetic entry modules that need every provider in the
 * graph before contract metadata can be indexed. Consumers must resolve roles
 * by ID after loading; these paths are not codegen identities.
 */
export const MSGPACK_HOST_TRANSPORT_CONTRACT_PROVIDER_MODULES = [
  "std::msgpack",
  "std::msgpack::fns",
  "std::string",
] as const;

export type CompilerContractFeature =
  | "host-transport-msgpack"
  | "dto-data"
  | "retained-callback-call-scope";

export type CompilerContractPrimitiveType =
  | "bool"
  | "i32"
  | "i64"
  | "f32"
  | "f64";

export type CompilerContractSharedType =
  | "string"
  | "bytes"
  | "data"
  | "data-array"
  | "data-map"
  | "msgpack-reader"
  | "msgpack-writer";

/** Symbolic types are resolved relationally after typing, at feature use. */
export type CompilerContractTypeSpec =
  | { readonly kind: "primitive"; readonly name: CompilerContractPrimitiveType }
  | { readonly kind: "shared"; readonly name: CompilerContractSharedType }
  | {
      readonly kind: "fixed-array";
      readonly element: CompilerContractTypeSpec;
    };

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
  readonly provider:
    | { readonly namespace: "std" }
    | { readonly namespace: "pkg"; readonly packageName: string };
  readonly methodAlias?: string;
  readonly overloadPreference?: "least-generic";
};

const primitive = (
  name: CompilerContractPrimitiveType,
): CompilerContractTypeSpec => ({ kind: "primitive", name });
const shared = (
  name: CompilerContractSharedType,
): CompilerContractTypeSpec => ({ kind: "shared", name });
const fixedArray = (
  element: CompilerContractTypeSpec,
): CompilerContractTypeSpec => ({ kind: "fixed-array", element });

const type = {
  bool: primitive("bool"),
  i32: primitive("i32"),
  i64: primitive("i64"),
  f32: primitive("f32"),
  f64: primitive("f64"),
  string: shared("string"),
  bytes: shared("bytes"),
  data: shared("data"),
  dataArray: shared("data-array"),
  dataMap: shared("data-map"),
  reader: shared("msgpack-reader"),
  writer: shared("msgpack-writer"),
} as const;

const contract = (
  id: CompilerFunctionContractId,
  parameters: readonly CompilerContractTypeSpec[],
  result: CompilerContractTypeSpec,
): CompilerFunctionContractSpec => ({
  id,
  feature: "host-transport-msgpack",
  expectedArity: parameters.length,
  provider: { namespace: "std" },
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

const msgpackHostTransportContractSpecs: readonly CompilerFunctionContractSpec[] =
  [
    contract(
      MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.createReader,
      [type.i32, type.i32],
      type.reader,
    ),
    contract(
      MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.readerComplete,
      [type.reader],
      type.bool,
    ),
    contract(
      MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.createWriter,
      [type.i32, type.i32],
      type.writer,
    ),
    contract(
      MSGPACK_HOST_TRANSPORT_CONTRACT_IDS.finishWriter,
      [type.writer],
      type.i32,
    ),
  ];

const dataContract = (
  id: CompilerFunctionContractId,
  parameters: readonly CompilerContractTypeSpec[],
  result: CompilerContractTypeSpec,
): CompilerFunctionContractSpec => ({
  ...contract(id, parameters, result),
  feature: "dto-data",
});

const dtoDataContractSpecs: readonly CompilerFunctionContractSpec[] = [
  dataContract(DTO_DATA_CONTRACT_IDS.cycleError, [], type.data),
  dataContract(DTO_DATA_CONTRACT_IDS.makeNull, [], type.data),
  dataContract(DTO_DATA_CONTRACT_IDS.makeBool, [type.bool], type.data),
  dataContract(DTO_DATA_CONTRACT_IDS.makeString, [type.string], type.data),
  dataContract(DTO_DATA_CONTRACT_IDS.makeBytes, [type.bytes], type.data),
  dataContract(DTO_DATA_CONTRACT_IDS.makeArray, [type.dataArray], type.data),
  dataContract(DTO_DATA_CONTRACT_IDS.makeI32, [type.i32], type.data),
  dataContract(DTO_DATA_CONTRACT_IDS.makeI64, [type.i64], type.data),
  dataContract(DTO_DATA_CONTRACT_IDS.makeF32, [type.f32], type.data),
  dataContract(DTO_DATA_CONTRACT_IDS.makeF64, [type.f64], type.data),
  dataContract(DTO_DATA_CONTRACT_IDS.makeMap, [type.dataMap], type.data),
  dataContract(DTO_DATA_CONTRACT_IDS.unpackBool, [type.data], type.bool),
  dataContract(DTO_DATA_CONTRACT_IDS.unpackString, [type.data], type.string),
  dataContract(DTO_DATA_CONTRACT_IDS.unpackBytes, [type.data], type.bytes),
  dataContract(DTO_DATA_CONTRACT_IDS.unpackArray, [type.data], type.dataArray),
  dataContract(DTO_DATA_CONTRACT_IDS.unpackI32, [type.data], type.i32),
  dataContract(DTO_DATA_CONTRACT_IDS.unpackI64, [type.data], type.i64),
  dataContract(DTO_DATA_CONTRACT_IDS.unpackF32, [type.data], type.f32),
  dataContract(DTO_DATA_CONTRACT_IDS.unpackF64, [type.data], type.f64),
  dataContract(DTO_DATA_CONTRACT_IDS.unpackMap, [type.data], type.dataMap),
  dataContract(
    DTO_DATA_CONTRACT_IDS.arrayWithCapacity,
    [type.i32],
    type.dataArray,
  ),
  dataContract(
    DTO_DATA_CONTRACT_IDS.arrayPush,
    [type.dataArray, type.data],
    type.dataArray,
  ),
  dataContract(DTO_DATA_CONTRACT_IDS.arrayLength, [type.dataArray], type.i32),
  dataContract(
    DTO_DATA_CONTRACT_IDS.arrayRawStorage,
    [type.dataArray],
    fixedArray(type.data),
  ),
  dataContract(DTO_DATA_CONTRACT_IDS.mapNew, [], type.dataMap),
  dataContract(
    DTO_DATA_CONTRACT_IDS.mapSet,
    [type.dataMap, type.string, type.data],
    type.dataMap,
  ),
  dataContract(
    DTO_DATA_CONTRACT_IDS.mapGet,
    [type.dataMap, type.string],
    type.data,
  ),
  dataContract(
    DTO_DATA_CONTRACT_IDS.mapHas,
    [type.dataMap, type.string],
    type.bool,
  ),
  dataContract(
    DTO_DATA_CONTRACT_IDS.mapTagIs,
    [type.dataMap, type.string],
    type.bool,
  ),
  dataContract(
    DTO_DATA_CONTRACT_IDS.newString,
    [fixedArray(type.i32)],
    type.string,
  ),
];

const webRenderContract = ({
  id,
  expectedArity,
  methodAlias,
}: {
  id: CompilerFunctionContractId;
  expectedArity: number;
  methodAlias?: string;
}): CompilerFunctionContractSpec => ({
  id,
  feature: "retained-callback-call-scope",
  expectedArity,
  provider: { namespace: "pkg", packageName: "web" },
  overloadPreference: "least-generic",
  ...(methodAlias ? { methodAlias } : {}),
  signature: {
    typeParameters: 0,
    parameters: Array.from({ length: expectedArity }, () => ({
      type: type.i32,
      optional: false as const,
    })),
    result: type.i32,
    effect: "pure",
  },
});

const webRenderContractSpecs: readonly CompilerFunctionContractSpec[] = [
  webRenderContract({
    id: WEB_RENDER_CONTRACT_IDS.typedRender,
    expectedArity: 1,
  }),
  webRenderContract({
    id: WEB_RENDER_CONTRACT_IDS.typedDocument,
    expectedArity: 1,
  }),
  webRenderContract({
    id: WEB_RENDER_CONTRACT_IDS.typedHydratedDocument,
    expectedArity: 2,
  }),
  webRenderContract({
    id: WEB_RENDER_CONTRACT_IDS.typedNamedHydratedDocument,
    expectedArity: 2,
  }),
  webRenderContract({
    id: WEB_RENDER_CONTRACT_IDS.typedHtmlResponse,
    expectedArity: 2,
  }),
  webRenderContract({
    id: WEB_RENDER_CONTRACT_IDS.typedHydratedHtmlResponse,
    expectedArity: 3,
  }),
  webRenderContract({
    id: WEB_RENDER_CONTRACT_IDS.typedNamedHydratedHtmlResponse,
    expectedArity: 3,
  }),
  webRenderContract({
    id: WEB_RENDER_CONTRACT_IDS.responseHtml,
    expectedArity: 2,
    methodAlias: "html",
  }),
  webRenderContract({
    id: WEB_RENDER_CONTRACT_IDS.hydratedResponseHtml,
    expectedArity: 3,
    methodAlias: "html",
  }),
];

export const COMPILER_FUNCTION_CONTRACTS: ReadonlyMap<
  CompilerFunctionContractId,
  CompilerFunctionContractSpec
> = new Map(
  [
    ...msgpackHostTransportContractSpecs,
    ...dtoDataContractSpecs,
    ...webRenderContractSpecs,
  ].map((spec) => [spec.id, spec]),
);

export const getCompilerFunctionContractSpec = (
  id: string,
): CompilerFunctionContractSpec | undefined =>
  COMPILER_FUNCTION_CONTRACTS.get(id as CompilerFunctionContractId);

export const isCompilerFunctionContractId = (
  id: string,
): id is CompilerFunctionContractId =>
  COMPILER_FUNCTION_CONTRACTS.has(id as CompilerFunctionContractId);
