export const HOST_TRANSPORT_PROVIDER_CONTRACT_ID =
  "voyd.std.host-transport-provider" as const;

export type CompilerTraitContractId =
  typeof HOST_TRANSPORT_PROVIDER_CONTRACT_ID;

export type CompilerTraitMethodRole =
  | "createReader"
  | "readerComplete"
  | "createWriter"
  | "finishWriter";

export type CompilerTraitContractSpec = {
  readonly id: CompilerTraitContractId;
  readonly expectedTypeParameters: number;
  readonly provider: { readonly namespace: "std" };
  readonly methods: readonly {
    readonly role: CompilerTraitMethodRole;
    readonly name: string;
    readonly expectedArity: number;
  }[];
};

export const HOST_TRANSPORT_PROVIDER_CONTRACT: CompilerTraitContractSpec = {
  id: HOST_TRANSPORT_PROVIDER_CONTRACT_ID,
  expectedTypeParameters: 2,
  provider: { namespace: "std" },
  methods: [
    { role: "createReader", name: "create_reader", expectedArity: 2 },
    { role: "readerComplete", name: "reader_complete", expectedArity: 1 },
    { role: "createWriter", name: "create_writer", expectedArity: 2 },
    { role: "finishWriter", name: "finish_writer", expectedArity: 1 },
  ],
};

export const COMPILER_TRAIT_CONTRACTS: ReadonlyMap<
  CompilerTraitContractId,
  CompilerTraitContractSpec
> = new Map([
  [HOST_TRANSPORT_PROVIDER_CONTRACT.id, HOST_TRANSPORT_PROVIDER_CONTRACT],
]);

export const getCompilerTraitContractSpec = (
  id: string,
): CompilerTraitContractSpec | undefined =>
  COMPILER_TRAIT_CONTRACTS.get(id as CompilerTraitContractId);

export const isCompilerTraitContractId = (
  id: string,
): id is CompilerTraitContractId =>
  COMPILER_TRAIT_CONTRACTS.has(id as CompilerTraitContractId);
