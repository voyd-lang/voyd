export const VOYD_PACKAGE_ADAPTER_ABI = 1 as const;

/** Stable, transport-neutral schema written to generated adapter contracts. */
export type VoydDtoSchema =
  | { kind: "bool" | "i32" | "i64" | "f32" | "f64" | "void" | "string" }
  | { kind: "array"; element: VoydDtoSchema }
  | {
      kind: "record";
      tag?: string;
      fields: readonly VoydDtoFieldSchema[];
    }
  | {
      kind: "union";
      variants: readonly VoydDtoVariantSchema[];
    };

export type VoydDtoFieldSchema = {
  name: string;
  schema: VoydDtoSchema;
  optional?: boolean;
};

export type VoydDtoVariantSchema = {
  name: string;
  fields: readonly VoydDtoFieldSchema[];
};

export type VoydExternalFunctionContract = {
  kind: "sync" | "async";
  interfaceId: string;
  functionName: string;
  params: readonly VoydDtoSchema[];
  result: VoydDtoSchema;
};

export type VoydPackageAdapterContract = {
  abiVersion: typeof VOYD_PACKAGE_ADAPTER_ABI;
  packageName: string;
  interfaces: readonly VoydExternalInterfaceContract[];
  functions: readonly VoydExternalFunctionContract[];
};

export type VoydPackageAdapterContractInput = Omit<
  VoydPackageAdapterContract,
  "interfaces"
> & { interfaces?: readonly VoydExternalInterfaceContract[] };

export type VoydExternalInterfaceContract = {
  interfaceId: string;
  /** Fingerprint of every function in this versioned interface. */
  fingerprint: string;
};

/** Host-owned capabilities available to adapter calls without coupling adapters to VX. */
export type VoydPackageAdapterInvocationContext = Readonly<{
  signal?: AbortSignal;
  resources?: VoydPackageAdapterResourceStore;
}>;

/** Opaque resource table reserved for resource handles in future component-model adapters. */
export type VoydPackageAdapterResourceStore = Readonly<{
  get(handle: number): unknown;
}>;

export type VoydExternalFunction = (
  this: VoydPackageAdapterInvocationContext,
  ...args: never[]
) => unknown;

export type VoydPackageAdapterImplementation = Readonly<
  Record<string, Readonly<Record<string, VoydExternalFunction>>>
>;

export type VoydPackageAdapter = Readonly<{
  kind: "voyd-package-adapter";
  contract: VoydPackageAdapterContract;
  implementation: VoydPackageAdapterImplementation;
}>;

export const defineVoydPackageAdapter = (
  input: VoydPackageAdapterContractInput,
  implementation: VoydPackageAdapterImplementation,
): VoydPackageAdapter => {
  const contract: VoydPackageAdapterContract = {
    ...input,
    interfaces: input.interfaces ?? interfaceContractsFor(input.functions),
  };
  validateContract(contract);
  const expected = new Set(
    contract.functions.map(({ interfaceId, functionName }) =>
      functionKey(interfaceId, functionName),
    ),
  );
  const actual = new Set<string>();
  Object.entries(implementation).forEach(([interfaceId, functions]) => {
    Object.entries(functions).forEach(([functionName, fn]) => {
      if (typeof fn !== "function") {
        throw new TypeError(
          `Voyd package adapter ${contract.packageName} ${functionKey(interfaceId, functionName)} must be a function`,
        );
      }
      const key = functionKey(interfaceId, functionName);
      if (!expected.has(key)) {
        throw new Error(
          `Voyd package adapter ${contract.packageName} implements unknown external function ${key}`,
        );
      }
      actual.add(key);
    });
  });
  const missing = [...expected].filter((key) => !actual.has(key));
  if (missing.length > 0) {
    throw new Error(
      `Voyd package adapter ${contract.packageName} is missing external functions: ${missing.join(", ")}`,
    );
  }
  return Object.freeze({
    kind: "voyd-package-adapter" as const,
    contract: deepFreeze(contract),
    implementation: deepFreeze(implementation),
  });
};

export const voydInterfaceFingerprint = (
  functions: readonly VoydExternalFunctionContract[],
): string => {
  const canonical = [...functions]
    .sort((left, right) => left.functionName.localeCompare(right.functionName))
    .map(({ kind, functionName, params, result }) => ({ kind, functionName, params, result }));
  return stableHash(JSON.stringify(canonical));
};

const interfaceContractsFor = (
  functions: readonly VoydExternalFunctionContract[],
): VoydExternalInterfaceContract[] => {
  const ids = [...new Set(functions.map(({ interfaceId }) => interfaceId))].sort();
  return ids.map((interfaceId) => ({
    interfaceId,
    fingerprint: voydInterfaceFingerprint(
      functions.filter((fn) => fn.interfaceId === interfaceId),
    ),
  }));
};

export const isVoydPackageAdapter = (
  value: unknown,
): value is VoydPackageAdapter =>
  typeof value === "object" &&
  value !== null &&
  (value as { kind?: unknown }).kind === "voyd-package-adapter" &&
  (value as { contract?: { abiVersion?: unknown } }).contract?.abiVersion ===
    VOYD_PACKAGE_ADAPTER_ABI;

const validateContract = (contract: VoydPackageAdapterContract): void => {
  if (contract.abiVersion !== VOYD_PACKAGE_ADAPTER_ABI) {
    throw new Error(
      `Unsupported Voyd package adapter ABI ${String(contract.abiVersion)}; expected ${VOYD_PACKAGE_ADAPTER_ABI}`,
    );
  }
  if (!contract.packageName.trim()) {
    throw new Error("Voyd package adapter contract requires a packageName");
  }
  {
    const interfaceIds = new Set(contract.functions.map(({ interfaceId }) => interfaceId));
    const fingerprintIds = contract.interfaces.map(({ interfaceId }) => interfaceId);
    if (
      contract.interfaces.length !== interfaceIds.size ||
      new Set(fingerprintIds).size !== fingerprintIds.length
    ) {
      throw new Error(`Voyd package adapter ${contract.packageName} requires one unique fingerprint per interface`);
    }
    contract.interfaces.forEach(({ interfaceId, fingerprint }) => {
      const functions = contract.functions.filter((fn) => fn.interfaceId === interfaceId);
      if (functions.length === 0 || !interfaceIds.has(interfaceId)) {
        throw new Error(`Voyd package adapter ${contract.packageName} fingerprints unknown interface ${interfaceId}`);
      }
      if (voydInterfaceFingerprint(functions) !== fingerprint) {
        throw new Error(`Voyd package adapter ${contract.packageName} has an invalid fingerprint for ${interfaceId}`);
      }
    });
  }
  const keys = contract.functions.map(({ kind, interfaceId, functionName }) => {
    if (!interfaceId.trim() || !functionName.trim()) {
      throw new Error("Voyd external functions require interfaceId and functionName");
    }
    if (kind !== "sync" && kind !== "async") {
      throw new Error(`Voyd external function ${functionKey(interfaceId, functionName)} requires a sync or async kind`);
    }
    return functionKey(interfaceId, functionName);
  });
  if (new Set(keys).size !== keys.length) {
    throw new Error(`Voyd package adapter ${contract.packageName} contains duplicate external functions`);
  }
};

export function externalFunctionKey(
  interfaceId: string,
  functionName: string,
): string {
  return `${interfaceId}::${functionName}`;
}

const functionKey = externalFunctionKey;

const deepFreeze = <T>(value: T, seen = new WeakSet<object>()): T => {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  Object.values(value).forEach((child) => deepFreeze(child, seen));
  return Object.freeze(value);
};

const stableHash = (value: string): string => {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0).toString(16).padStart(8, "0")}`;
};
