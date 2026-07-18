import type { ProgramSymbolId, SymbolId } from "./ids.js";
import type {
  BoundaryMetadata,
  IntrinsicFunctionFlags,
  SerializerMetadata,
} from "./symbol-index.js";
import type { SemanticsPipelineResult } from "./pipeline.js";
import { getSymbolTable } from "./_internal/symbol-table.js";
import type {
  CompilerFunctionContractId,
  CompilerFunctionContractSpec,
  StdIntrinsicTypeContractId,
  StdIntrinsicTypeContractProvider,
} from "../compiler-contracts/index.js";

export type SymbolRef = {
  moduleId: string;
  symbol: SymbolId;
};

export type ProgramSymbolArena = {
  idOf(ref: SymbolRef): ProgramSymbolId;
  tryIdOf(ref: SymbolRef): ProgramSymbolId | undefined;
  refOf(id: ProgramSymbolId): SymbolRef;
  getName(id: ProgramSymbolId): string | undefined;
  getDocumentation(id: ProgramSymbolId): string | undefined;
  getPackageId(id: ProgramSymbolId): string;
  getIntrinsicType(id: ProgramSymbolId): string | undefined;
  getStdIntrinsicTypeContract(
    id: ProgramSymbolId,
  ): StdIntrinsicTypeContractProvider | undefined;
  resolveStdIntrinsicTypeContract(
    id: StdIntrinsicTypeContractId,
  ): ProgramSymbolId | undefined;
  getIntrinsicName(id: ProgramSymbolId): string | undefined;
  getIntrinsicFunctionFlags(id: ProgramSymbolId): IntrinsicFunctionFlags;
  getCompilerFunctionContract(
    id: ProgramSymbolId,
  ): CompilerFunctionContractSpec | undefined;
  resolveCompilerFunctionContract(
    id: CompilerFunctionContractId,
  ): ProgramSymbolId | undefined;
  getSerializer(id: ProgramSymbolId): SerializerMetadata | undefined;
  getBoundary(id: ProgramSymbolId): BoundaryMetadata | undefined;
  isModuleScoped(id: ProgramSymbolId): boolean;
};

const getOrCreateMap = <K, V>(map: Map<K, V>, key: K, create: () => V): V => {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }
  const next = create();
  map.set(key, next);
  return next;
};

export const buildProgramSymbolArena = (
  modules: readonly SemanticsPipelineResult[]
): ProgramSymbolArena => {
  const stableModules = [...modules].sort((a, b) =>
    a.moduleId.localeCompare(b.moduleId, undefined, { numeric: true })
  );

  const idsByModuleAndSymbol = new Map<string, Map<SymbolId, ProgramSymbolId>>();
  const refsById: SymbolRef[] = [];
  const namesById: (string | undefined)[] = [];
  const documentationById: (string | undefined)[] = [];
  const packageIdsById: string[] = [];
  const intrinsicTypesById: (string | undefined)[] = [];
  const stdIntrinsicTypeContractsById: (
    | StdIntrinsicTypeContractProvider
    | undefined
  )[] = [];
  const idsByStdIntrinsicTypeContract = new Map<
    StdIntrinsicTypeContractId,
    ProgramSymbolId
  >();
  const intrinsicNamesById: (string | undefined)[] = [];
  const intrinsicFlagsById: IntrinsicFunctionFlags[] = [];
  const compilerFunctionContractsById: (
    | CompilerFunctionContractSpec
    | undefined
  )[] = [];
  const idsByCompilerFunctionContract = new Map<
    CompilerFunctionContractId,
    ProgramSymbolId
  >();
  const serializerById: (SerializerMetadata | undefined)[] = [];
  const boundaryById: (BoundaryMetadata | undefined)[] = [];
  const moduleScopedById: boolean[] = [];

  let nextId = 0;
  stableModules.forEach((mod) => {
    const symbolTable = getSymbolTable(mod);
    const snapshot = symbolTable.snapshot();
    snapshot.symbols.forEach((record) => {
      if (!record) return;
      const symbol = record.id as SymbolId;
      const id = nextId as ProgramSymbolId;
      nextId += 1;

      const bySymbol = getOrCreateMap(
        idsByModuleAndSymbol,
        mod.moduleId,
        () => new Map<SymbolId, ProgramSymbolId>()
      );
      bySymbol.set(symbol, id);

      refsById[id] = { moduleId: mod.moduleId, symbol };
      namesById[id] = mod.symbols.getName(symbol);
      documentationById[id] =
        mod.binding.decls.getObject(symbol)?.documentation ??
        mod.binding.decls.getTypeAlias(symbol)?.documentation;
      packageIdsById[id] = mod.binding.packageId;
      intrinsicTypesById[id] = mod.symbols.getIntrinsicType(symbol);
      const stdIntrinsicTypeContract =
        mod.symbols.getStdIntrinsicTypeContract(symbol);
      stdIntrinsicTypeContractsById[id] = stdIntrinsicTypeContract;
      if (stdIntrinsicTypeContract) {
        const existing = idsByStdIntrinsicTypeContract.get(
          stdIntrinsicTypeContract.id,
        );
        if (existing !== undefined) {
          const first = refsById[existing]!;
          throw new Error(
            `duplicate reserved std intrinsic type contract '${stdIntrinsicTypeContract.id}': ${first.moduleId}::${first.symbol} and ${mod.moduleId}::${symbol}`,
          );
        }
        idsByStdIntrinsicTypeContract.set(stdIntrinsicTypeContract.id, id);
      }
      intrinsicNamesById[id] = mod.symbols.getIntrinsicName(symbol);
      intrinsicFlagsById[id] = mod.symbols.getIntrinsicFunctionFlags(symbol);
      const compilerFunctionContract =
        mod.symbols.getCompilerFunctionContract(symbol);
      compilerFunctionContractsById[id] = compilerFunctionContract;
      if (compilerFunctionContract) {
        const existing = idsByCompilerFunctionContract.get(
          compilerFunctionContract.id,
        );
        if (existing !== undefined) {
          const first = refsById[existing]!;
          throw new Error(
            `duplicate compiler function contract '${compilerFunctionContract.id}': ${first.moduleId}::${first.symbol} and ${mod.moduleId}::${symbol}`,
          );
        }
        idsByCompilerFunctionContract.set(compilerFunctionContract.id, id);
      }
      serializerById[id] = mod.symbols.getSerializer(symbol);
      boundaryById[id] = mod.symbols.getBoundary(symbol);
      moduleScopedById[id] = mod.symbols.isModuleScoped(symbol);
    });
  });

  const tryIdOf = (ref: SymbolRef): ProgramSymbolId | undefined =>
    idsByModuleAndSymbol.get(ref.moduleId)?.get(ref.symbol);

  const idOf = (ref: SymbolRef): ProgramSymbolId => {
    const id = tryIdOf(ref);
    if (typeof id === "number") {
      return id;
    }
    throw new Error(`missing ProgramSymbolId for ${ref.moduleId}::${ref.symbol}`);
  };

  const refOf = (id: ProgramSymbolId): SymbolRef => {
    const ref = refsById[id];
    if (!ref) {
      throw new Error(`unknown ProgramSymbolId ${id}`);
    }
    return ref;
  };

  const getName = (id: ProgramSymbolId): string | undefined => namesById[id];

  const getPackageId = (id: ProgramSymbolId): string => {
    const value = packageIdsById[id];
    if (!value) {
      throw new Error(`unknown package id for ProgramSymbolId ${id}`);
    }
    return value;
  };

  return {
    idOf,
    tryIdOf,
    refOf,
    getName,
    getDocumentation: (id) => documentationById[id],
    getPackageId,
    getIntrinsicType: (id) => intrinsicTypesById[id],
    getStdIntrinsicTypeContract: (id) => stdIntrinsicTypeContractsById[id],
    resolveStdIntrinsicTypeContract: (id) =>
      idsByStdIntrinsicTypeContract.get(id),
    getIntrinsicName: (id) => intrinsicNamesById[id],
    getIntrinsicFunctionFlags: (id) =>
      intrinsicFlagsById[id] ?? {
        intrinsic: false,
        intrinsicUsesSignature: false,
      },
    getCompilerFunctionContract: (id) => compilerFunctionContractsById[id],
    resolveCompilerFunctionContract: (id) =>
      idsByCompilerFunctionContract.get(id),
    getSerializer: (id) => serializerById[id],
    getBoundary: (id) => boundaryById[id],
    isModuleScoped: (id) => moduleScopedById[id] === true,
  };
};
