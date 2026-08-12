import { describe, expect, it } from "vitest";
import type {
  CodegenFunctionSignature,
  CodegenTraitImplInstance,
  CodegenTypeDesc,
  ProgramCodegenView,
} from "../../semantics/codegen-view/index.js";
import type { ProgramSymbolId, TypeId } from "../../semantics/ids.js";
import {
  HOST_TRANSPORT_PROVIDER_CONTRACT_ID,
  resolveSelectedHostTransportProvider,
} from "../index.js";

const type = {
  bool: 1 as TypeId,
  i32: 2 as TypeId,
  reader: 10 as TypeId,
  writer: 11 as TypeId,
  providerTrait: 20 as TypeId,
  providerTarget: 30 as TypeId,
};

const symbol = {
  providerTrait: 100 as ProgramSymbolId,
  providerImpl: 101 as ProgramSymbolId,
  createReaderTrait: 110 as ProgramSymbolId,
  readerCompleteTrait: 111 as ProgramSymbolId,
  createWriterTrait: 112 as ProgramSymbolId,
  finishWriterTrait: 113 as ProgramSymbolId,
  createReaderImpl: 120 as ProgramSymbolId,
  readerCompleteImpl: 121 as ProgramSymbolId,
  createWriterImpl: 122 as ProgramSymbolId,
  finishWriterImpl: 123 as ProgramSymbolId,
  dataReaderTrait: 130 as ProgramSymbolId,
  dataWriterTrait: 131 as ProgramSymbolId,
  dataReaderImpl: 140 as ProgramSymbolId,
  dataWriterImpl: 141 as ProgramSymbolId,
  providerOwner: 200 as ProgramSymbolId,
  readerOwner: 201 as ProgramSymbolId,
  writerOwner: 202 as ProgramSymbolId,
};

const providerImplementation: CodegenTraitImplInstance = {
  trait: type.providerTrait,
  traitSymbol: symbol.providerTrait,
  target: type.providerTarget,
  methods: [],
  staticMethods: [
    {
      traitMethod: symbol.createReaderTrait,
      implMethod: symbol.createReaderImpl,
    },
    {
      traitMethod: symbol.readerCompleteTrait,
      implMethod: symbol.readerCompleteImpl,
    },
    {
      traitMethod: symbol.createWriterTrait,
      implMethod: symbol.createWriterImpl,
    },
    {
      traitMethod: symbol.finishWriterTrait,
      implMethod: symbol.finishWriterImpl,
    },
  ],
  implSymbol: symbol.providerImpl,
};

const readerImplementation: CodegenTraitImplInstance = {
  trait: 40 as TypeId,
  traitSymbol: symbol.dataReaderTrait,
  target: type.reader,
  methods: [],
  staticMethods: [],
  implSymbol: symbol.dataReaderImpl,
};

const writerImplementation: CodegenTraitImplInstance = {
  trait: 41 as TypeId,
  traitSymbol: symbol.dataWriterTrait,
  target: type.writer,
  methods: [],
  staticMethods: [],
  implSymbol: symbol.dataWriterImpl,
};

const signature = (
  parameters: readonly TypeId[],
  result: TypeId,
): CodegenFunctionSignature =>
  ({
    typeId: 900 as TypeId,
    scheme: 901,
    parameters: parameters.map((typeId) => ({ typeId, optional: false })),
    returnType: result,
    effectRow: 0,
    typeParams: [],
  }) as CodegenFunctionSignature;

const makeProgram = ({
  implementations = [providerImplementation],
  createReaderResult = type.reader,
}: {
  implementations?: readonly CodegenTraitImplInstance[];
  createReaderResult?: TypeId;
} = {}): ProgramCodegenView => {
  const names = new Map<ProgramSymbolId, string>([
    [symbol.createReaderTrait, "create_reader"],
    [symbol.readerCompleteTrait, "reader_complete"],
    [symbol.createWriterTrait, "create_writer"],
    [symbol.finishWriterTrait, "finish_writer"],
    [symbol.dataReaderTrait, "DataReader"],
    [symbol.dataWriterTrait, "DataWriter"],
  ]);
  const signatures = new Map<ProgramSymbolId, CodegenFunctionSignature>([
    [
      symbol.createReaderImpl,
      signature([type.i32, type.i32], createReaderResult),
    ],
    [symbol.readerCompleteImpl, signature([type.reader], type.bool)],
    [symbol.createWriterImpl, signature([type.i32, type.i32], type.writer)],
    [symbol.finishWriterImpl, signature([type.writer], type.i32)],
  ]);
  const descriptors = new Map<TypeId, CodegenTypeDesc>([
    [type.bool, { kind: "primitive", name: "bool" }],
    [type.i32, { kind: "primitive", name: "i32" }],
    [
      type.reader,
      {
        kind: "nominal-object",
        owner: symbol.readerOwner,
        name: "Reader",
        typeArgs: [],
      },
    ],
    [
      type.writer,
      {
        kind: "nominal-object",
        owner: symbol.writerOwner,
        name: "Writer",
        typeArgs: [],
      },
    ],
    [
      type.providerTarget,
      {
        kind: "nominal-object",
        owner: symbol.providerOwner,
        name: "Provider",
        typeArgs: [],
      },
    ],
    [
      type.providerTrait,
      {
        kind: "trait",
        owner: symbol.providerTrait,
        name: "HostTransportProvider",
        typeArgs: [type.reader, type.writer],
      },
    ],
  ]);

  return {
    primitives: {
      bool: type.bool,
      i32: type.i32,
      i64: 3,
      f32: 4,
      f64: 5,
      void: 6,
      unknown: 7,
      defaultEffectRow: 0,
    },
    effects: { isEmpty: (row: number) => row === 0 },
    types: {
      getTypeDesc: (typeId: TypeId) => descriptors.get(typeId)!,
      getNominalOwner: (typeId: TypeId) =>
        typeId === type.providerTarget
          ? symbol.providerOwner
          : typeId === type.reader || typeId === type.writer
            ? (typeId as unknown as ProgramSymbolId)
            : undefined,
      unify: (left: TypeId, right: TypeId) =>
        left === right
          ? { ok: true, substitution: new Map() }
          : { ok: false, conflict: { left, right, message: "different" } },
    },
    symbols: {
      resolveCompilerTraitContract: (id: string) =>
        id === HOST_TRANSPORT_PROVIDER_CONTRACT_ID
          ? symbol.providerTrait
          : undefined,
      getCompilerImplementation: (impl: ProgramSymbolId) =>
        impl === symbol.providerImpl || impl === (102 as ProgramSymbolId)
          ? { id: "voyd.std.msgpack", version: 1 }
          : undefined,
      getPackageId: () => "std",
      getName: (id: ProgramSymbolId) => names.get(id),
      refOf: (id: ProgramSymbolId) => ({
        moduleId:
          id === symbol.dataReaderTrait || id === symbol.dataWriterTrait
            ? "std::data"
            : "std::msgpack::fns",
        symbol: id,
      }),
    },
    objects: {
      getTemplate: (owner: ProgramSymbolId) =>
        owner === symbol.providerOwner ? { fields: [], params: [] } : undefined,
    },
    traits: {
      getImplsByTrait: (trait: ProgramSymbolId) =>
        trait === symbol.providerTrait ? implementations : [],
      getImplsByNominal: (nominal: TypeId) =>
        nominal === type.reader
          ? [readerImplementation]
          : nominal === type.writer
            ? [writerImplementation]
            : [],
    },
    functions: {
      getSignature: (_moduleId: string, id: ProgramSymbolId) =>
        signatures.get(id),
    },
  } as unknown as ProgramCodegenView;
};

describe("host transport compiler implementation resolution", () => {
  it("resolves identity, types, and exact static impl methods", () => {
    const resolved = resolveSelectedHostTransportProvider(makeProgram());

    expect(resolved.identity).toEqual({ id: "voyd.std.msgpack", version: 1 });
    expect(resolved.readerTypeId).toBe(type.reader);
    expect(resolved.writerTypeId).toBe(type.writer);
    expect(resolved.functions).toEqual({
      createReader: symbol.createReaderImpl,
      readerComplete: symbol.readerCompleteImpl,
      createWriter: symbol.createWriterImpl,
      finishWriter: symbol.finishWriterImpl,
    });
  });

  it("rejects a specialized method whose relational signature drifts", () => {
    expect(() =>
      resolveSelectedHostTransportProvider(
        makeProgram({ createReaderResult: type.bool }),
      ),
    ).toThrow(/create_reader.*wrong result type/);
  });

  it("rejects duplicate registered implementations", () => {
    expect(() =>
      resolveSelectedHostTransportProvider(
        makeProgram({
          implementations: [
            providerImplementation,
            { ...providerImplementation, implSymbol: 102 as ProgramSymbolId },
          ],
        }),
      ),
    ).toThrow(/duplicate @compiler_impl registration/);
  });
});
