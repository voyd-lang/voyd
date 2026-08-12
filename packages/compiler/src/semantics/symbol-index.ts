import type { SymbolId } from "./ids.js";
import type { SymbolTable } from "./binder/index.js";
import {
  getCompilerFunctionContractSpec,
  getCompilerTraitContractSpec,
  getStdIntrinsicTypeContractSpec,
  type CompilerFunctionContractId,
  type CompilerFunctionContractSpec,
  type CompilerTraitContractId,
  type CompilerTraitContractSpec,
  type StdIntrinsicTypeContractId,
  type StdIntrinsicTypeContractProvider,
} from "../compiler-contracts/index.js";

export type IntrinsicFunctionFlags = {
  intrinsic: boolean;
  intrinsicUsesSignature: boolean;
  external?: { interfaceId: string; functionName: string };
};

export type CompilerImplementationDeclaration = {
  id: string;
  version: number;
};

export type ModuleSymbolIndex = {
  moduleId: string;
  packageId: string;
  getName(symbol: SymbolId): string | undefined;
  resolveTopLevel(name: string): SymbolId | undefined;
  isModuleScoped(symbol: SymbolId): boolean;
  getIntrinsicType(symbol: SymbolId): string | undefined;
  resolveIntrinsicType(id: string): SymbolId | undefined;
  getCompilerImplementation(
    symbol: SymbolId,
  ): CompilerImplementationDeclaration | undefined;
  getCompilerTraitContract(
    symbol: SymbolId,
  ): CompilerTraitContractSpec | undefined;
  resolveCompilerTraitContract(
    id: CompilerTraitContractId,
  ): SymbolId | undefined;
  getStdIntrinsicTypeContract(
    symbol: SymbolId,
  ): StdIntrinsicTypeContractProvider | undefined;
  resolveStdIntrinsicTypeContract(
    id: StdIntrinsicTypeContractId,
  ): SymbolId | undefined;
  getIntrinsicName(symbol: SymbolId): string | undefined;
  getIntrinsicFunctionFlags(symbol: SymbolId): IntrinsicFunctionFlags;
  getCompilerFunctionContract(
    symbol: SymbolId,
  ): CompilerFunctionContractSpec | undefined;
  resolveCompilerFunctionContract(
    id: CompilerFunctionContractId,
  ): SymbolId | undefined;
};

export const buildModuleSymbolIndex = ({
  moduleId,
  packageId,
  symbolTable,
}: {
  moduleId: string;
  packageId: string;
  symbolTable: SymbolTable;
}): ModuleSymbolIndex => {
  const nameBySymbol = new Map<SymbolId, string>();
  const topLevelByName = new Map<string, SymbolId>();
  const moduleScopedBySymbol = new Map<SymbolId, boolean>();
  const intrinsicTypeBySymbol = new Map<SymbolId, string>();
  const symbolsByIntrinsicType = new Map<string, SymbolId[]>();
  const compilerImplementationBySymbol = new Map<
    SymbolId,
    CompilerImplementationDeclaration
  >();
  const compilerTraitContractBySymbol = new Map<
    SymbolId,
    CompilerTraitContractSpec
  >();
  const symbolsByCompilerTraitContract = new Map<
    CompilerTraitContractId,
    SymbolId[]
  >();
  const stdIntrinsicTypeContractBySymbol = new Map<
    SymbolId,
    StdIntrinsicTypeContractProvider
  >();
  const symbolsByStdIntrinsicTypeContract = new Map<
    StdIntrinsicTypeContractId,
    SymbolId[]
  >();
  const intrinsicNameBySymbol = new Map<SymbolId, string>();
  const intrinsicFlagsBySymbol = new Map<SymbolId, IntrinsicFunctionFlags>();
  const compilerFunctionContractBySymbol = new Map<
    SymbolId,
    CompilerFunctionContractSpec
  >();
  const symbolsByCompilerFunctionContract = new Map<
    CompilerFunctionContractId,
    SymbolId[]
  >();

  const snapshot = symbolTable.snapshot();
  snapshot.symbols.forEach((record) => {
    if (!record) return;
    const symbol = record.id as SymbolId;
    nameBySymbol.set(symbol, record.name);
    moduleScopedBySymbol.set(
      symbol,
      symbolTable.getScope(record.scope).kind === "module",
    );
    if (
      record.scope === symbolTable.rootScope &&
      !topLevelByName.has(record.name)
    ) {
      topLevelByName.set(record.name, symbol);
    }

    const metadata = (record.metadata ?? {}) as {
      intrinsicType?: unknown;
      stdIntrinsicTypeContract?: unknown;
      entity?: unknown;
      objectKind?: unknown;
      intrinsicName?: unknown;
      intrinsic?: unknown;
      intrinsicUsesSignature?: unknown;
      externalFunction?: unknown;
      compilerFunctionContract?: unknown;
      import?: unknown;
      compilerImplementation?: unknown;
      compilerTraitContract?: unknown;
    };

    if (typeof metadata.intrinsicType === "string") {
      intrinsicTypeBySymbol.set(symbol, metadata.intrinsicType);
      if (!metadata.import) {
        const symbols =
          symbolsByIntrinsicType.get(metadata.intrinsicType) ?? [];
        symbols.push(symbol);
        symbolsByIntrinsicType.set(metadata.intrinsicType, symbols);
      }
    }
    if (
      !metadata.import &&
      isCompilerImplementationDeclaration(metadata.compilerImplementation)
    ) {
      compilerImplementationBySymbol.set(
        symbol,
        metadata.compilerImplementation,
      );
    }
    const compilerTraitContract = metadata.import
      ? undefined
      : readCompilerTraitContract(metadata.compilerTraitContract);
    if (compilerTraitContract) {
      compilerTraitContractBySymbol.set(symbol, compilerTraitContract);
      const symbols =
        symbolsByCompilerTraitContract.get(compilerTraitContract.id) ?? [];
      symbols.push(symbol);
      symbolsByCompilerTraitContract.set(compilerTraitContract.id, symbols);
    }
    const stdIntrinsicTypeContract = metadata.import
      ? undefined
      : readStdIntrinsicTypeContract({ metadata, packageId });
    if (stdIntrinsicTypeContract) {
      stdIntrinsicTypeContractBySymbol.set(symbol, stdIntrinsicTypeContract);
      const contractSymbols =
        symbolsByStdIntrinsicTypeContract.get(stdIntrinsicTypeContract.id) ??
        [];
      contractSymbols.push(symbol);
      symbolsByStdIntrinsicTypeContract.set(
        stdIntrinsicTypeContract.id,
        contractSymbols,
      );
    }
    if (typeof metadata.intrinsicName === "string") {
      intrinsicNameBySymbol.set(symbol, metadata.intrinsicName);
    }
    if (
      metadata.intrinsic === true ||
      metadata.intrinsicUsesSignature === true
    ) {
      intrinsicFlagsBySymbol.set(symbol, {
        intrinsic: metadata.intrinsic === true,
        intrinsicUsesSignature: metadata.intrinsicUsesSignature === true,
        ...(isExternalFunctionMetadata(metadata.externalFunction)
          ? { external: metadata.externalFunction }
          : {}),
      });
    }
    const compilerFunctionContract = metadata.import
      ? undefined
      : readCompilerFunctionContract(metadata.compilerFunctionContract);
    if (compilerFunctionContract) {
      compilerFunctionContractBySymbol.set(symbol, compilerFunctionContract);
      const contractSymbols =
        symbolsByCompilerFunctionContract.get(compilerFunctionContract.id) ??
        [];
      contractSymbols.push(symbol);
      symbolsByCompilerFunctionContract.set(
        compilerFunctionContract.id,
        contractSymbols,
      );
    }
  });

  return {
    moduleId,
    packageId,
    getName: (symbol) => nameBySymbol.get(symbol),
    resolveTopLevel: (name) => topLevelByName.get(name),
    isModuleScoped: (symbol) => moduleScopedBySymbol.get(symbol) === true,
    getIntrinsicType: (symbol) => intrinsicTypeBySymbol.get(symbol),
    resolveIntrinsicType: (id) => {
      const symbols = symbolsByIntrinsicType.get(id) ?? [];
      if (symbols.length > 1) {
        throw new Error(`duplicate intrinsic type '${id}' in ${moduleId}`);
      }
      return symbols[0];
    },
    getCompilerImplementation: (symbol) =>
      compilerImplementationBySymbol.get(symbol),
    getCompilerTraitContract: (symbol) =>
      compilerTraitContractBySymbol.get(symbol),
    resolveCompilerTraitContract: (id) => {
      const symbols = symbolsByCompilerTraitContract.get(id) ?? [];
      if (symbols.length > 1) {
        throw new Error(
          `duplicate compiler trait contract '${id}' in ${moduleId} on symbols ${symbols.join(", ")}`,
        );
      }
      return symbols[0];
    },
    getStdIntrinsicTypeContract: (symbol) =>
      stdIntrinsicTypeContractBySymbol.get(symbol),
    resolveStdIntrinsicTypeContract: (id) => {
      const symbols = symbolsByStdIntrinsicTypeContract.get(id) ?? [];
      if (symbols.length > 1) {
        throw new Error(
          `duplicate reserved std intrinsic type contract '${id}' in ${moduleId} on symbols ${symbols.join(
            ", ",
          )}`,
        );
      }
      return symbols[0];
    },
    getIntrinsicName: (symbol) => intrinsicNameBySymbol.get(symbol),
    getIntrinsicFunctionFlags: (symbol) =>
      intrinsicFlagsBySymbol.get(symbol) ?? {
        intrinsic: false,
        intrinsicUsesSignature: false,
      },
    getCompilerFunctionContract: (symbol) =>
      compilerFunctionContractBySymbol.get(symbol),
    resolveCompilerFunctionContract: (id) => {
      const symbols = symbolsByCompilerFunctionContract.get(id) ?? [];
      if (symbols.length > 1) {
        throw new Error(
          `duplicate compiler function contract '${id}' in ${moduleId} on symbols ${symbols.join(
            ", ",
          )}`,
        );
      }
      return symbols[0];
    },
  };
};

const isCompilerImplementationDeclaration = (
  value: unknown,
): value is CompilerImplementationDeclaration =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string" &&
  typeof (value as { version?: unknown }).version === "number";

const readCompilerTraitContract = (
  value: unknown,
): CompilerTraitContractSpec | undefined => {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as { id?: unknown }).id;
  if (typeof id !== "string") return undefined;
  return getCompilerTraitContractSpec(id);
};

const isExternalFunctionMetadata = (
  value: unknown,
): value is { interfaceId: string; functionName: string } =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { interfaceId?: unknown }).interfaceId === "string" &&
  typeof (value as { functionName?: unknown }).functionName === "string";

const readStdIntrinsicTypeContract = ({
  metadata,
  packageId,
}: {
  metadata: {
    intrinsicType?: unknown;
    stdIntrinsicTypeContract?: unknown;
    entity?: unknown;
    objectKind?: unknown;
  };
  packageId: string;
}): StdIntrinsicTypeContractProvider | undefined => {
  if (
    packageId !== "std" ||
    !metadata.stdIntrinsicTypeContract ||
    typeof metadata.stdIntrinsicTypeContract !== "object"
  ) {
    return undefined;
  }
  const provider = metadata.stdIntrinsicTypeContract as {
    id?: unknown;
    providerKind?: unknown;
  };
  if (typeof provider.id !== "string") {
    return undefined;
  }
  if (
    provider.providerKind !== "nominal-object" &&
    provider.providerKind !== "value-object"
  ) {
    return undefined;
  }
  const spec = getStdIntrinsicTypeContractSpec(provider.id);
  const expectedProviderKind =
    metadata.entity === "object"
      ? metadata.objectKind === "value"
        ? "value-object"
        : metadata.objectKind === "obj"
          ? "nominal-object"
          : undefined
      : undefined;
  if (
    !spec ||
    metadata.intrinsicType !== spec.id ||
    provider.providerKind !== expectedProviderKind ||
    !spec.providerKinds.includes(provider.providerKind)
  ) {
    return undefined;
  }
  return {
    id: spec.id,
    providerKind: provider.providerKind,
  };
};

const readCompilerFunctionContract = (
  value: unknown,
): CompilerFunctionContractSpec | undefined => {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as {
    id?: unknown;
    feature?: unknown;
    expectedArity?: unknown;
  };
  if (typeof record.id !== "string") {
    return undefined;
  }
  const spec = getCompilerFunctionContractSpec(record.id);
  if (
    !spec ||
    record.feature !== spec.feature ||
    record.expectedArity !== spec.expectedArity
  ) {
    return undefined;
  }
  return spec;
};
