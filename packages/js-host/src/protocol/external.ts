import { decode, encode } from "@msgpack/msgpack";
import {
  externalFunctionKey,
  isVoydPackageAdapter,
  type VoydDtoSchema,
  type VoydPackageAdapter,
  type VoydPackageAdapterInvocationContext,
} from "@voyd-lang/package-adapter";
import { decodeBoundaryArgs, encodeBoundaryArgs } from "../boundary-values.js";
import type { EffectContinuation, EffectHandler, HostProtocolTable } from "./types.js";

export const EXTERNAL_IMPORT_MODULE = "voyd.external";
export const EXTERNAL_REQUIREMENTS_SECTION = "voyd.external_requirements";
export const EXTERNAL_BUFFER_SIZE_IMPORT = "buffer_size";
export const EXTERNAL_BUFFER_ERROR_IMPORT = "buffer_error";

/** Internal schema emitted by the core-Wasm fallback compiler ABI. */
export type VoydBoundarySchema =
  | { kind: "bool" | "i32" | "i64" | "f32" | "f64" | "void" | "string"; typeId?: number }
  | { kind: "array"; typeId?: number; aliases?: readonly number[]; elementTypeId?: number; element: VoydBoundarySchema }
  | { kind: "record"; typeId?: number; aliases?: readonly number[]; name?: string; tag?: string; fields: readonly VoydBoundaryFieldSchema[] }
  | { kind: "union"; typeId?: number; aliases?: readonly number[]; name?: string; variants: readonly VoydBoundaryVariantSchema[] }
  | { kind: "ref"; typeId: number };

type VoydBoundaryFieldSchema = {
  name: string;
  typeId?: number;
  schema: VoydBoundarySchema;
  optional?: boolean;
};

type VoydBoundaryVariantSchema = {
  name: string;
  typeId?: number;
  fields: readonly VoydBoundaryFieldSchema[];
};

export type ExternalFunctionRequirement = {
  kind: "sync" | "async";
  interfaceId: string;
  functionName: string;
  params: readonly VoydBoundarySchema[];
  result: VoydBoundarySchema;
  effect?: {
    opId: number;
    signatureHash: string;
    resumeKind: "resume" | "tail";
  };
};

export type ParsedExternalRequirements = {
  version: number;
  functions: readonly ExternalFunctionRequirement[];
};

const MSGPACK_OPTIONS = { useBigInt64: true } as const;
const INVOCATION_CONTEXT: VoydPackageAdapterInvocationContext = Object.freeze({});

export const parseExternalRequirements = (
  module: WebAssembly.Module,
): ParsedExternalRequirements => {
  const sections = WebAssembly.Module.customSections(
    module,
    EXTERNAL_REQUIREMENTS_SECTION,
  );
  if (sections.length === 0) return { version: 0, functions: [] };
  const parsed = JSON.parse(
    new TextDecoder().decode(new Uint8Array(sections[0]!)),
  ) as Partial<ParsedExternalRequirements>;
  return {
    version: typeof parsed.version === "number" ? parsed.version : 0,
    functions: Array.isArray(parsed.functions) ? parsed.functions : [],
  };
};

export const buildExternalImportModule = ({
  requirements,
  adapters,
  bufferSize,
  getInstance,
}: {
  requirements: ParsedExternalRequirements;
  adapters: readonly VoydPackageAdapter[];
  bufferSize: number;
  getInstance: () => WebAssembly.Instance;
}): WebAssembly.Imports => {
  if (requirements.functions.length === 0) return {};
  if (requirements.version !== 1) {
    throw new Error(
      `Unsupported Voyd external requirements version ${requirements.version}`,
    );
  }

  const providers = buildProviderMap(
    adapters,
    new Set(requirements.functions.map((requirement) =>
      externalFunctionKey(requirement.interfaceId, requirement.functionName),
    )),
  );
  const imports: Record<string, CallableFunction | (() => number)> = {
    [EXTERNAL_BUFFER_SIZE_IMPORT]: () => bufferSize,
    [EXTERNAL_BUFFER_ERROR_IMPORT]: (() => {
      throw new Error(
        `Voyd external argument payload exceeds bufferSize ${bufferSize}; increase createVoydHost({ bufferSize })`,
      );
    }) as CallableFunction,
  };
  requirements.functions.filter((requirement) => requirement.kind !== "async").forEach((requirement) => {
    const key = externalFunctionKey(
      requirement.interfaceId,
      requirement.functionName,
    );
    const provider = providers.get(key);
    if (!provider) {
      throw new Error(
        `Missing Voyd package adapter for external function ${key}`,
      );
    }
    assertCompatibleContract({ requirement, provider });
    imports[key] = (inPtr: number, inLen: number, outPtr: number, outCap: number) => {
      const memory = requireMemory(getInstance());
      const argsValue = decode(
        new Uint8Array(memory.buffer, inPtr, inLen),
        MSGPACK_OPTIONS,
      );
      if (!Array.isArray(argsValue)) {
        throw externalCallError(key, "arguments payload was not an array");
      }
      const args = decodeBoundaryArgs({
        exportName: `external function ${key}`,
        schemas: requirement.params,
        args: argsValue,
      });
      let result: unknown;
      try {
        result = provider.fn.call(INVOCATION_CONTEXT, ...args);
      } catch (cause) {
        throw externalCallError(key, "adapter threw", cause);
      }
      if (isPromiseLike(result)) {
        throw externalCallError(
          key,
          "returned a Promise from a synchronous external function",
        );
      }
      const boundaryResult = encodeBoundaryArgs({
        exportName: `external function ${key}`,
        schemas: [requirement.result],
        args: [result],
      })[0];
      const encoded = encode(boundaryResult, MSGPACK_OPTIONS) as Uint8Array;
      if (encoded.length > outCap) {
        throw externalCallError(
          key,
          `result requires ${encoded.length} bytes but bufferSize is ${bufferSize}; increase createVoydHost({ bufferSize })`,
        );
      }
      new Uint8Array(memory.buffer, outPtr, encoded.length).set(encoded);
      return encoded.length;
    };
  });
  return { [EXTERNAL_IMPORT_MODULE]: imports };
};

export const registerExternalAdapterHandlers = ({
  requirements,
  adapters,
  table,
  registerHandler,
}: {
  requirements: ParsedExternalRequirements;
  adapters: readonly VoydPackageAdapter[];
  table: HostProtocolTable;
  registerHandler: (
    effectId: string,
    opId: number,
    signatureHash: string,
    handler: EffectHandler,
  ) => void;
}): void => {
  const asyncRequirements = requirements.functions.filter(
    (requirement) => requirement.kind === "async",
  );
  if (asyncRequirements.length === 0) return;
  const providers = buildProviderMap(
    adapters,
    new Set(requirements.functions.map((requirement) =>
      externalFunctionKey(requirement.interfaceId, requirement.functionName),
    )),
  );
  asyncRequirements.forEach((requirement) => {
    const key = externalFunctionKey(requirement.interfaceId, requirement.functionName);
    const effect = requirement.effect;
    if (!effect) throw new Error(`External async function ${key} is missing effect metadata`);
    const provider = providers.get(key);
    if (!provider) throw new Error(`Missing Voyd package adapter for external function ${key}`);
    assertCompatibleContract({ requirement, provider });
    const descriptor = table.ops.find(
      (op) =>
        op.effectId === requirement.interfaceId &&
        op.opId === effect.opId &&
        op.signatureHash === effect.signatureHash,
    );
    if (!descriptor) throw new Error(`External async function ${key} has no matching effect operation`);
    const handler: EffectHandler = async (
      continuation: EffectContinuation,
      ...rawArgs: unknown[]
    ) => {
      const args = decodeBoundaryArgs({
        exportName: `external function ${key}`,
        schemas: requirement.params,
        args: rawArgs,
      });
      let value: unknown;
      try {
        value = await provider.fn.call(INVOCATION_CONTEXT, ...args);
      } catch (cause) {
        throw externalCallError(key, "adapter rejected", cause);
      }
      const result = encodeBoundaryArgs({
        exportName: `external function ${key}`,
        schemas: [requirement.result],
        args: [value],
      })[0];
      return continuation[effect.resumeKind](result);
    };
    registerHandler(
      requirement.interfaceId,
      effect.opId,
      effect.signatureHash,
      handler,
    );
  });
};

const buildProviderMap = (
  adapters: readonly VoydPackageAdapter[],
  requiredKeys: ReadonlySet<string>,
): Map<
  string,
  {
    packageName: string;
    contract: VoydPackageAdapter["contract"]["functions"][number];
    fn: (this: VoydPackageAdapterInvocationContext, ...args: readonly unknown[]) => unknown;
  }
> => {
  const providers = new Map<
    string,
    {
      packageName: string;
      contract: VoydPackageAdapter["contract"]["functions"][number];
      fn: (this: VoydPackageAdapterInvocationContext, ...args: readonly unknown[]) => unknown;
    }
  >();
  const interfaceProviders = new Map<string, string>();
  adapters.forEach((adapter) => {
    if (!isVoydPackageAdapter(adapter)) {
      throw new Error("Unsupported or malformed Voyd package adapter ABI");
    }
    const requiredInterfaces = new Set(
      adapter.contract.functions
        .filter((contract) => requiredKeys.has(externalFunctionKey(contract.interfaceId, contract.functionName)))
        .map(({ interfaceId }) => interfaceId),
    );
    requiredInterfaces.forEach((interfaceId) => {
      const existing = interfaceProviders.get(interfaceId);
      if (existing) {
        throw new Error(
          `Multiple Voyd package adapters provide interface ${interfaceId}: ${existing}, ${adapter.contract.packageName}`,
        );
      }
      interfaceProviders.set(interfaceId, adapter.contract.packageName);
    });
    adapter.contract.functions.forEach((contract) => {
      const key = externalFunctionKey(contract.interfaceId, contract.functionName);
      if (!requiredKeys.has(key)) return;
      if (providers.has(key)) {
        throw new Error(`Multiple Voyd package adapters provide ${key}`);
      }
      const implementation = adapter.implementation[contract.interfaceId]?.[contract.functionName];
      const fn = implementation as
        | ((this: VoydPackageAdapterInvocationContext, ...args: readonly unknown[]) => unknown)
        | undefined;
      if (!fn) {
        throw new Error(
          `Voyd package adapter ${adapter.contract.packageName} is missing ${key}`,
        );
      }
      providers.set(key, {
        packageName: adapter.contract.packageName,
        contract,
        fn,
      });
    });
  });
  return providers;
};

const assertCompatibleContract = ({
  requirement,
  provider,
}: {
  requirement: ExternalFunctionRequirement;
  provider: {
    packageName: string;
    contract: VoydPackageAdapter["contract"]["functions"][number];
  };
}): void => {
  const expected = canonicalContract({
    kind: requirement.kind,
    params: requirement.params,
    result: requirement.result,
  });
  const actual = canonicalContract(provider.contract);
  if (expected !== actual) {
    const key = externalFunctionKey(
      requirement.interfaceId,
      requirement.functionName,
    );
    throw new Error(
      `Voyd package adapter ${provider.packageName} has an incompatible contract for ${key}`,
    );
  }
};

const canonicalContract = ({
  kind,
  params,
  result,
}: {
  kind: "sync" | "async";
  params: readonly (VoydBoundarySchema | VoydDtoSchema)[];
  result: VoydBoundarySchema | VoydDtoSchema;
}): string => {
  const normalizedIds = new Map<number, number>();
  let nextId = 1;
  const normalizeId = (typeId: number): number => {
    const existing = normalizedIds.get(typeId);
    if (existing !== undefined) return existing;
    const created = nextId++;
    normalizedIds.set(typeId, created);
    return created;
  };
  const runtimeSchemas = new Map<number, VoydBoundarySchema>();
  const register = (schema: VoydBoundarySchema | VoydDtoSchema): void => {
    if (schema.kind === "ref") {
      normalizeId(schema.typeId);
      return;
    }
    if (
      (schema.kind === "array" || schema.kind === "record" || schema.kind === "union") &&
      "typeId" in schema &&
      schema.typeId !== undefined
    ) {
      const canonical = normalizeId(schema.typeId);
      runtimeSchemas.set(schema.typeId, schema);
      schema.aliases?.forEach((alias) => {
        normalizedIds.set(alias, canonical);
        runtimeSchemas.set(alias, schema);
      });
    }
    if (schema.kind === "array") register(schema.element);
    if (schema.kind === "record") schema.fields.forEach((field) => register(field.schema));
    if (schema.kind === "union") {
      schema.variants.forEach((variant) => variant.fields.forEach((field) => register(field.schema)));
    }
  };
  [...params, result].forEach(register);
  return JSON.stringify({
    kind,
    params: params.map((schema) => canonicalSchema(schema, normalizeId, runtimeSchemas)),
    result: canonicalSchema(result, normalizeId, runtimeSchemas),
  });
};

const canonicalSchema = (
  schema: VoydBoundarySchema | VoydDtoSchema,
  normalizeId: (typeId: number) => number,
  runtimeSchemas?: ReadonlyMap<number, VoydBoundarySchema>,
): unknown => {
  switch (schema.kind) {
    case "array":
      return { kind: schema.kind, element: canonicalSchema(schema.element, normalizeId, runtimeSchemas) };
    case "record":
      return {
        kind: schema.kind,
        tag: schema.tag,
        fields: schema.fields.map((field) => ({
          name: field.name,
          optional: field.optional === true,
          schema: canonicalSchema(field.schema, normalizeId, runtimeSchemas),
        })),
      };
    case "union":
      return {
        kind: schema.kind,
        variants: schema.variants.map((variant) => ({
          name: variant.name,
          fields: variant.fields.map((field) => ({
            name: field.name,
            optional: field.optional === true,
            schema: canonicalSchema(field.schema, normalizeId, runtimeSchemas),
          })),
        })),
      };
    case "ref": {
      const target = runtimeSchemas?.get(schema.typeId);
      return target
        ? canonicalSchema(target, normalizeId, runtimeSchemas)
        : { kind: schema.kind, typeId: normalizeId(schema.typeId) };
    }
    default:
      return { kind: schema.kind };
  }
};

const requireMemory = (instance: WebAssembly.Instance): WebAssembly.Memory => {
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("Voyd external function requires exported memory");
  }
  return memory;
};

const isPromiseLike = (value: unknown): value is PromiseLike<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { then?: unknown }).then === "function";

const externalCallError = (
  key: string,
  message: string,
  cause?: unknown,
): Error => {
  const error = new Error(`Voyd external function ${key} ${message}`);
  if (cause !== undefined) (error as Error & { cause?: unknown }).cause = cause;
  return error;
};
