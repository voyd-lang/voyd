import { decode, encode } from "@msgpack/msgpack";
import type binaryen from "binaryen";
import { EFFECT_TABLE_EXPORT } from "./effect-table.js";
import { RESUME_KIND, type ResumeKind } from "./runtime-abi.js";
import {
  MIN_EFFECT_BUFFER_SIZE,
  MSGPACK_READ_VALUE,
  MSGPACK_WRITE_EFFECT,
  MSGPACK_WRITE_VALUE,
  VALUE_TAG,
} from "./host-boundary.js";
import { toBase64 } from "./base64.js";

const TABLE_HEADER_SIZE = 8;
const OP_ENTRY_SIZE = 28;
const MSGPACK_OPTS = { useBigInt64: true } as const;

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

export type EffectHandler = (
  request: EffectHandlerRequest,
  ...args: unknown[]
) => unknown | Promise<unknown>;

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

type MsgPackHost = {
  imports: WebAssembly.Imports;
  setMemory: (memory: WebAssembly.Memory) => void;
  lastEncodedLength: () => number;
  recordLength: (len: number) => void;
};

export const createMsgPackHost = (): MsgPackHost => {
  let memory: WebAssembly.Memory | undefined;
  let latestLength = 0;
  const scratch = new DataView(new ArrayBuffer(8));
  const memoryView = (): ArrayBuffer => {
    if (!memory) {
      throw new Error("memory is not set on msgpack host");
    }
    return memory.buffer;
  };
  const decodeValueBits = (tag: number, value: unknown): bigint => {
    if (tag === VALUE_TAG.none) return 0n;
    if (tag === VALUE_TAG.i32) {
      if (typeof value === "boolean") return value ? 1n : 0n;
      const asNumber = typeof value === "number" ? value : Number(value);
      return BigInt.asIntN(32, BigInt(asNumber | 0));
    }
    if (tag === VALUE_TAG.i64) {
      if (typeof value === "bigint") return BigInt.asIntN(64, value);
      if (typeof value === "boolean") return value ? 1n : 0n;
      const asNumber = typeof value === "number" ? value : Number(value);
      return BigInt.asIntN(64, BigInt(Math.trunc(asNumber)));
    }
    if (tag === VALUE_TAG.f32) {
      const asNumber = typeof value === "number" ? value : Number(value);
      scratch.setFloat32(0, asNumber, true);
      const bits = scratch.getUint32(0, true);
      return BigInt(bits);
    }
    if (tag === VALUE_TAG.f64) {
      const asNumber = typeof value === "number" ? value : Number(value);
      scratch.setFloat64(0, asNumber, true);
      return scratch.getBigInt64(0, true);
    }
    throw new Error(`unsupported read value tag ${tag}`);
  };
  const encodeValueBits = (tag: number, bits: bigint): unknown => {
    if (tag === VALUE_TAG.none) return null;
    if (tag === VALUE_TAG.i32) return Number(BigInt.asIntN(32, bits));
    if (tag === VALUE_TAG.i64) return BigInt.asIntN(64, bits);
    if (tag === VALUE_TAG.f32) {
      scratch.setUint32(0, Number(BigInt.asUintN(32, bits)), true);
      return scratch.getFloat32(0, true);
    }
    if (tag === VALUE_TAG.f64) {
      scratch.setBigUint64(0, BigInt.asUintN(64, bits), true);
      return scratch.getFloat64(0, true);
    }
    throw new Error(`unsupported write value tag ${tag}`);
  };
  const write = ({
    ptr,
    len,
    payload,
  }: {
    ptr: number;
    len: number;
    payload: unknown;
  }): number => {
    const encoded = encode(payload, MSGPACK_OPTS) as Uint8Array;
    latestLength = encoded.length;
    if (encoded.length > len) {
      // eslint-disable-next-line no-console
      console.error("msgpack overflow", { len, needed: encoded.length });
      return -1;
    }
    new Uint8Array(memoryView(), ptr, encoded.length).set(encoded);
    return 0;
  };

  return {
    imports: {
      env: {
        [MSGPACK_WRITE_VALUE]: (
          tag: number,
          value: bigint,
          ptr: number,
          len: number
        ) =>
          write({
            ptr,
            len,
            payload: {
              kind: "value",
              value: encodeValueBits(tag, value),
            },
          }),
        [MSGPACK_WRITE_EFFECT]: (
          effectId: bigint,
          opId: number,
          opIndex: number,
          resumeKind: number,
          handle: number,
          argsPtr: number,
          argCount: number,
          ptr: number,
          len: number
        ) => {
          const view = new DataView(memoryView());
          const args: number[] = [];
          for (let index = 0; index < argCount; index += 1) {
            args.push(view.getInt32(argsPtr + index * 4, true));
          }
          return write({
            ptr,
            len,
            payload: {
              kind: "effect",
              effectId: BigInt.asIntN(64, effectId),
              opId,
              opIndex,
              resumeKind,
              handle,
              args,
            },
          });
        },
        [MSGPACK_READ_VALUE]: (tag: number, ptr: number, len: number) => {
          const size = latestLength > 0 ? latestLength : len;
          const slice = new Uint8Array(memoryView(), ptr, size);
          const decoded = decode(slice, MSGPACK_OPTS) as unknown;
          return decodeValueBits(tag, decoded);
        },
      },
    },
    setMemory: (mem) => {
      memory = mem;
    },
    lastEncodedLength: () => latestLength,
    recordLength: (len: number) => {
      latestLength = len;
    },
  };
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
  const host = createMsgPackHost();
  const mergedImports = {
    ...(imports ?? {}),
    ...host.imports,
    env: { ...(imports?.env ?? {}), ...(host.imports.env ?? {}) },
  };
  const { instance, table } = instantiateEffectModule({
    wasm,
    imports: mergedImports,
    tableExport,
  });
  const memory = instance.exports.memory;
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error("expected module to export memory");
  }
  host.setMemory(memory);

  const initEffects = instance.exports.init_effects as CallableFunction | undefined;
  const effectStatus = instance.exports.effect_status as CallableFunction;
  const effectCont = instance.exports.effect_cont as CallableFunction;
  const resumeEffectful = instance.exports.resume_effectful as CallableFunction;
  const entry = instance.exports[entryName];
  if (typeof entry !== "function") {
    throw new Error(`Missing export ${entryName}`);
  }
  if (
    typeof effectStatus !== "function" ||
    typeof effectCont !== "function" ||
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
  const bufferPtr = table.ops.length * 4;
  if (bufferPtr + bufferSize > memory.buffer.byteLength) {
    throw new Error("effect buffer exceeds module memory size");
  }

  const memoryView = new DataView(memory.buffer);
  table.ops.forEach((op) => {
    const handle = handleByOpIndex.get(op.opIndex) ?? 0;
    memoryView.setUint32(op.opIndex * 4, handle, true);
  });
  if (typeof initEffects === "function") {
    initEffects();
  }

  const decodeLast = (): any => {
    const length = host.lastEncodedLength();
    if (length <= 0) {
      throw new Error("no msgpack payload written to buffer");
    }
    const bytes = new Uint8Array(memory.buffer, bufferPtr, length);
    return decode(bytes, MSGPACK_OPTS);
  };

  let result = (entry as CallableFunction)(bufferPtr, bufferSize);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const status = effectStatus(result) as number;
    if (status === 0) {
      const decoded = decodeLast();
      return {
        value: (decoded as { value: T }).value,
        table,
        instance,
      };
    }

    if (status === 1) {
      const decoded = decodeLast() as {
        effectId: bigint;
        opId: number;
        opIndex: number;
        resumeKind: number;
        handle: number;
        args: unknown[];
      };
      const resumeKind = parseResumeKind(decoded.resumeKind);
      const handle = decoded.handle;
      const opIndex = opIndexByHandle.get(handle) ?? decoded.opIndex;
      const opEntry = table.ops[opIndex];
      if (!opEntry) {
        throw new Error(`Unknown effect op index ${decoded.opIndex}`);
      }
      const decodedEffectId =
        typeof decoded.effectId === "bigint"
          ? BigInt.asUintN(64, decoded.effectId)
          : undefined;
      if (
        typeof decodedEffectId === "bigint" &&
        decodedEffectId !== opEntry.effectIdHash.value
      ) {
        throw new Error(
          `Effect id mismatch for opIndex ${opEntry.opIndex} (expected ${opEntry.effectIdHash.hex})`
        );
      }
      if (decoded.opIndex !== opEntry.opIndex) {
        throw new Error(
          `Effect op index mismatch for handle ${handle} (expected ${opEntry.opIndex}, got ${decoded.opIndex})`
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
      const resumeValue = await handler(request, ...(decoded.args ?? []));
      const encoded = encode(resumeValue, MSGPACK_OPTS) as Uint8Array;
      if (encoded.length > bufferSize) {
        throw new Error("resume payload exceeds buffer size");
      }
      new Uint8Array(memory.buffer, bufferPtr, encoded.length).set(encoded);
      host.recordLength(encoded.length);
      try {
        result = resumeEffectful(effectCont(result), bufferPtr, bufferSize);
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
