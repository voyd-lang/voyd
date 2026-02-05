import { decode, encode } from "@msgpack/msgpack";
import type binaryen from "binaryen";
import { EFFECT_TABLE_EXPORT } from "./effect-table.js";
import { RESUME_KIND, type ResumeKind } from "./runtime-abi.js";
import {
  EFFECT_RESULT_STATUS,
  EFFECTS_MEMORY_EXPORT,
  LINEAR_MEMORY_EXPORT,
  MIN_EFFECT_BUFFER_SIZE,
} from "./host-boundary.js";
import { toBase64 } from "./base64.js";

const TABLE_HEADER_SIZE = 8;
const OP_ENTRY_SIZE = 28;
const MSGPACK_OPTS = { useBigInt64: true } as const;
const WASM_PAGE_SIZE = 64 * 1024;

const NO_RESUME_BRAND = Symbol.for("voyd.no-resume");

export type NoResume<T = unknown> = {
  readonly [NO_RESUME_BRAND]: true;
  readonly value: T;
};

export const noResume = <T>(value: T): NoResume<T> => ({
  [NO_RESUME_BRAND]: true,
  value,
});

const isNoResume = (value: unknown): value is NoResume => {
  if (!value || typeof value !== "object") return false;
  return (value as Record<symbol, unknown>)[NO_RESUME_BRAND] === true;
};

const ensureMemoryCapacity = (
  memory: WebAssembly.Memory,
  requiredBytes: number,
  label: string
): void => {
  const requiredPages = Math.ceil(requiredBytes / WASM_PAGE_SIZE);
  const currentPages = memory.buffer.byteLength / WASM_PAGE_SIZE;
  if (requiredPages <= currentPages) {
    return;
  }
  try {
    memory.grow(requiredPages - currentPages);
  } catch (error) {
    throw new Error(`${label} memory grow failed`, { cause: error });
  }
};

const decodePayload = ({
  memory,
  ptr,
  length,
}: {
  memory: WebAssembly.Memory;
  ptr: number;
  length: number;
}): unknown => {
  if (length <= 0) {
    throw new Error("no msgpack payload written to buffer");
  }
  const bytes = new Uint8Array(memory.buffer, ptr, length);
  return decode(bytes, MSGPACK_OPTS);
};

type WasmSource =
  | binaryen.Module
  | Uint8Array
  | ArrayBuffer
  | WebAssembly.Module;

const normalizeBinary = (
  bytes: Uint8Array<ArrayBufferLike>
): Uint8Array => new Uint8Array(bytes);

const parseResumeKind = (value: number): ResumeKind => {
  if (value === RESUME_KIND.resume || value === RESUME_KIND.tail) {
    return value;
  }
  throw new Error(`unsupported resume kind ${value}`);
};

type EffectIdHash = {
  low: number;
  high: number;
  value: bigint;
  hex: string;
};

export interface ParsedEffectOp {
  opIndex: number;
  effectId: string;
  effectIdHash: EffectIdHash;
  opId: number;
  resumeKind: ResumeKind;
  signatureHash: number;
  label: string;
}

export interface ParsedEffectTable {
  version: number;
  tableExport: string;
  names: Uint8Array;
  namesBase64: string;
  ops: ParsedEffectOp[];
  opsByEffectId: Map<string, ParsedEffectOp[]>;
}

export interface EffectHandlerRequest {
  handle: number;
  opIndex: number;
  effectId: string;
  effectIdHash: bigint;
  effectIdHashHex: string;
  opId: number;
  resumeKind: ResumeKind;
  signatureHash: number;
  label: string;
}

export type EffectHandlerResult<T = unknown> = T | NoResume<T>;

export type EffectHandler<
  TArgs extends unknown[] = unknown[],
  TResult = unknown,
> = (
  request: EffectHandlerRequest,
  ...args: TArgs
) => EffectHandlerResult<TResult> | Promise<EffectHandlerResult<TResult>>;

const toBytes = (wasm: WasmSource): Uint8Array => {
  if (wasm instanceof Uint8Array) return normalizeBinary(wasm);
  if (wasm instanceof ArrayBuffer) return new Uint8Array(wasm);
  if (typeof WebAssembly !== "undefined" && wasm instanceof WebAssembly.Module) {
    throw new Error("Cannot derive bytes from a compiled WebAssembly.Module");
  }
  if (typeof (wasm as binaryen.Module).emitBinary === "function") {
    return normalizeBinary((wasm as binaryen.Module).emitBinary());
  }
  throw new Error("Unsupported wasm input");
};

const decodeName = (names: Uint8Array, offset: number): string => {
  if (offset < 0 || offset >= names.length) {
    throw new Error(`Name offset ${offset} is out of bounds`);
  }
  let cursor = offset;
  const bytes: number[] = [];
  while (cursor < names.length && names[cursor] !== 0) {
    bytes.push(names[cursor]);
    cursor += 1;
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
};

const effectIdHashFromParts = (low: number, high: number): EffectIdHash => {
  const value = BigInt.asUintN(64, (BigInt(high) << 32n) | BigInt(low));
  return {
    low,
    high,
    value,
    hex: `0x${high.toString(16).padStart(8, "0")}${low
      .toString(16)
      .padStart(8, "0")}`,
  };
};

export const parseEffectTable = (
  wasm: WasmSource,
  tableExport = EFFECT_TABLE_EXPORT
): ParsedEffectTable => {
  const module =
    wasm instanceof WebAssembly.Module
      ? wasm
      : new WebAssembly.Module(new Uint8Array(toBytes(wasm)));
  const sections = WebAssembly.Module.customSections(module, tableExport);
  if (sections.length === 0) {
    throw new Error(`Missing effect table export ${tableExport}`);
  }
  const payload = new Uint8Array(sections[0]!);
  const view = new DataView(
    payload.buffer,
    payload.byteOffset,
    payload.byteLength
  );
  let offset = 0;
  const read = () => {
    const value = view.getUint32(offset, true);
    offset += 4;
    return value;
  };

  const version = read();
  if (version !== 2) {
    throw new Error(`Unsupported effect table version ${version}`);
  }
  const opCount = read();

  const opEntries = Array.from({ length: opCount }, (_value, opIndex) => ({
    opIndex,
    effectIdLo: read(),
    effectIdHi: read(),
    effectIdNameOffset: read(),
    opId: read(),
    resumeKind: read(),
    signatureHash: read(),
    labelOffset: read(),
  }));

  const namesStart = TABLE_HEADER_SIZE + opEntries.length * OP_ENTRY_SIZE;
  if (namesStart > payload.length) {
    throw new Error("Effect table payload is truncated");
  }
  const names = payload.slice(namesStart);
  const namesBase64 = toBase64(names);

  const ops: ParsedEffectOp[] = opEntries.map((entry) => {
    const effectId = decodeName(names, entry.effectIdNameOffset);
    return {
      opIndex: entry.opIndex,
      effectId,
      effectIdHash: effectIdHashFromParts(entry.effectIdLo, entry.effectIdHi),
      opId: entry.opId,
      resumeKind: parseResumeKind(entry.resumeKind),
      signatureHash: entry.signatureHash,
      label: decodeName(names, entry.labelOffset),
    };
  });

  const opsByEffectId = new Map<string, ParsedEffectOp[]>();
  ops.forEach((op) => {
    const bucket = opsByEffectId.get(op.effectId) ?? [];
    bucket.push(op);
    opsByEffectId.set(op.effectId, bucket);
  });

  return {
    version,
    tableExport,
    names,
    namesBase64,
    ops,
    opsByEffectId,
  };
};

export const instantiateEffectModule = ({
  wasm,
  imports = {},
  tableExport = EFFECT_TABLE_EXPORT,
}: {
  wasm: WasmSource;
  imports?: WebAssembly.Imports;
  tableExport?: string;
}): {
  module: WebAssembly.Module;
  instance: WebAssembly.Instance;
  table: ParsedEffectTable;
} => {
  const module =
    wasm instanceof WebAssembly.Module
      ? wasm
      : new WebAssembly.Module(new Uint8Array(toBytes(wasm)));
  const table = parseEffectTable(module, tableExport);
  const instance = new WebAssembly.Instance(module, imports);
  return { module, instance, table };
};

const resumeKindName = (kind: ResumeKind): string =>
  kind === RESUME_KIND.tail ? "tail" : "resume";

const handlerKeyCandidates = (request: EffectHandlerRequest): string[] => [
  `${request.opIndex}`,
  `${request.effectId}:${request.opId}:${request.signatureHash}`,
  `${request.effectId}:${request.opId}:${request.resumeKind}:${request.signatureHash}`,
  `${request.effectId}:${request.opId}:${request.resumeKind}`,
  `${request.effectIdHash}:${request.opId}:${request.signatureHash}`,
  `${request.effectIdHash}:${request.opId}:${request.resumeKind}:${request.signatureHash}`,
  `${request.effectIdHash}:${request.opId}:${request.resumeKind}`,
  `${request.effectIdHashHex}:${request.opId}:${request.signatureHash}`,
  `${request.effectIdHashHex}:${request.opId}:${request.resumeKind}:${request.signatureHash}`,
  `${request.effectIdHashHex}:${request.opId}:${request.resumeKind}`,
  `${request.label}/${resumeKindName(request.resumeKind)}`,
  request.label,
];

const lookupHandler = ({
  handlers,
  request,
}: {
  handlers?: Record<string, EffectHandler>;
  request: EffectHandlerRequest;
}): EffectHandler | undefined => {
  if (!handlers) return undefined;
  for (const key of handlerKeyCandidates(request)) {
    const handler = handlers[key];
    if (handler) return handler;
  }
  return undefined;
};

const assignHandles = ({
  table,
  handlers,
}: {
  table: ParsedEffectTable;
  handlers?: Record<string, EffectHandler>;
}): {
  handleByOpIndex: Map<number, number>;
  opIndexByHandle: Map<number, number>;
  handlerByHandle: Map<number, EffectHandler>;
} => {
  const handleByOpIndex = new Map<number, number>();
  const opIndexByHandle = new Map<number, number>();
  const handlerByHandle = new Map<number, EffectHandler>();

  table.ops.forEach((op) => {
    const handle = op.opIndex;
    handleByOpIndex.set(op.opIndex, handle);
    opIndexByHandle.set(handle, op.opIndex);
    if (!handlers) return;
    const request: EffectHandlerRequest = {
      handle,
      opIndex: op.opIndex,
      effectId: op.effectId,
      effectIdHash: op.effectIdHash.value,
      effectIdHashHex: op.effectIdHash.hex,
      opId: op.opId,
      resumeKind: op.resumeKind,
      signatureHash: op.signatureHash,
      label: op.label,
    };
    const handler = lookupHandler({ handlers, request });
    if (!handler) return;
    handlerByHandle.set(handle, handler);
  });

  return { handleByOpIndex, opIndexByHandle, handlerByHandle };
};

export const runEffectfulExport = async <T = unknown>({
  wasm,
  entryName,
  handlers,
  imports,
  bufferSize = MIN_EFFECT_BUFFER_SIZE,
  tableExport = EFFECT_TABLE_EXPORT,
}: {
  wasm: WasmSource;
  entryName: string;
  handlers?: Record<string, EffectHandler>;
  imports?: WebAssembly.Imports;
  bufferSize?: number;
  tableExport?: string;
}): Promise<{
  value: T;
  table: ParsedEffectTable;
  instance: WebAssembly.Instance;
}> => {
  const { instance, table } = instantiateEffectModule({
    wasm,
    imports,
    tableExport,
  });
  const exportedEffectsMemory = instance.exports[
    EFFECTS_MEMORY_EXPORT as keyof WebAssembly.Exports
  ];
  if (!(exportedEffectsMemory instanceof WebAssembly.Memory)) {
    throw new Error(`expected module to export ${EFFECTS_MEMORY_EXPORT}`);
  }
  const msgpackMemory = instance.exports[
    LINEAR_MEMORY_EXPORT as keyof WebAssembly.Exports
  ];
  if (!(msgpackMemory instanceof WebAssembly.Memory)) {
    throw new Error(`expected module to export ${LINEAR_MEMORY_EXPORT}`);
  }

  const initEffects = instance.exports.init_effects as CallableFunction | undefined;
  const effectStatus = instance.exports.effect_status as CallableFunction;
  const effectCont = instance.exports.effect_cont as CallableFunction;
  const effectLen = instance.exports.effect_len as CallableFunction;
  const resumeEffectful = instance.exports.resume_effectful as CallableFunction;
  const entry = instance.exports[entryName];
  if (typeof entry !== "function") {
    throw new Error(`Missing export ${entryName}`);
  }
  if (
    typeof effectStatus !== "function" ||
    typeof effectCont !== "function" ||
    typeof effectLen !== "function" ||
    typeof resumeEffectful !== "function"
  ) {
    throw new Error("missing effect result helper exports");
  }

  if (table.ops.length > 0 && typeof initEffects !== "function") {
    throw new Error("missing init_effects export for effectful module");
  }

  const { handleByOpIndex, opIndexByHandle, handlerByHandle } = assignHandles({
    table,
    handlers,
  });
  const bufferPtr = 0;
  ensureMemoryCapacity(
    msgpackMemory,
    bufferPtr + bufferSize,
    LINEAR_MEMORY_EXPORT
  );
  ensureMemoryCapacity(exportedEffectsMemory, table.ops.length * 4, EFFECTS_MEMORY_EXPORT);

  const memoryView = new DataView(exportedEffectsMemory.buffer);
  table.ops.forEach((op) => {
    const handle = handleByOpIndex.get(op.opIndex) ?? 0;
    memoryView.setUint32(op.opIndex * 4, handle, true);
  });
  if (typeof initEffects === "function") {
    initEffects();
  }

  let result = (entry as CallableFunction)(bufferPtr, bufferSize);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const status = effectStatus(result) as number;
    const payloadLength = effectLen(result) as number;
    const decoded = decodePayload({
      memory: msgpackMemory,
      ptr: bufferPtr,
      length: payloadLength,
    });
    if (status === EFFECT_RESULT_STATUS.value) {
      return {
        value: decoded as T,
        table,
        instance,
      };
    }

    if (status === EFFECT_RESULT_STATUS.effect) {
      const decodedRequest = decoded as {
        effectId: bigint;
        opId: number;
        opIndex: number;
        resumeKind: number;
        handle: number;
        args: unknown[];
      };
      const resumeKind = parseResumeKind(decodedRequest.resumeKind);
      const handle = decodedRequest.handle;
      const opIndex = opIndexByHandle.get(handle) ?? decodedRequest.opIndex;
      const opEntry = table.ops[opIndex];
      if (!opEntry) {
        throw new Error(`Unknown effect op index ${decodedRequest.opIndex}`);
      }
      const decodedEffectId =
        typeof decodedRequest.effectId === "bigint"
          ? BigInt.asUintN(64, decodedRequest.effectId)
          : undefined;
      if (
        typeof decodedEffectId === "bigint" &&
        decodedEffectId !== opEntry.effectIdHash.value
      ) {
        throw new Error(
          `Effect id mismatch for opIndex ${opEntry.opIndex} (expected ${opEntry.effectIdHash.hex})`
        );
      }
      if (decodedRequest.opIndex !== opEntry.opIndex) {
        throw new Error(
          `Effect op index mismatch for handle ${handle} (expected ${opEntry.opIndex}, got ${decodedRequest.opIndex})`
        );
      }
      const request: EffectHandlerRequest = {
        handle,
        opIndex: opEntry.opIndex,
        effectId: opEntry.effectId,
        effectIdHash: opEntry.effectIdHash.value,
        effectIdHashHex: opEntry.effectIdHash.hex,
        opId: opEntry.opId,
        resumeKind,
        signatureHash: opEntry.signatureHash,
        label: opEntry.label,
      };
      if (resumeKind !== opEntry.resumeKind) {
        throw new Error(
          `Resume kind mismatch for ${opEntry.label} (expected ${opEntry.resumeKind}, got ${resumeKind})`
        );
      }
      const handler = handlerByHandle.get(handle) ?? lookupHandler({ handlers, request });
      if (!handler) {
        throw new Error(
          `Unhandled effect ${request.label} (${resumeKindName(request.resumeKind)})`
        );
      }
      const handlerResult = await handler(request, ...(decodedRequest.args ?? []));
      if (isNoResume(handlerResult)) {
        if (resumeKind === RESUME_KIND.tail) {
          throw new Error(`Missing tail resumption for ${request.label}`);
        }
        return {
          value: handlerResult.value as T,
          table,
          instance,
        };
      }

      const encoded = encode(handlerResult, MSGPACK_OPTS) as Uint8Array;
      if (encoded.length > bufferSize) {
        throw new Error("resume payload exceeds buffer size");
      }
      new Uint8Array(msgpackMemory.buffer, bufferPtr, encoded.length).set(encoded);
      try {
        result = resumeEffectful(effectCont(result), bufferPtr, encoded.length, bufferSize);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error("resume_effectful failed", { request });
        throw error;
      }
      continue;
    }

    throw new Error(`unexpected effect status ${status}`);
  }
};
