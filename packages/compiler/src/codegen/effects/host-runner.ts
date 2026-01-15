import { Buffer } from "node:buffer";
import { encode, decode } from "@msgpack/msgpack";
import type binaryen from "binaryen";
import { EFFECT_TABLE_EXPORT } from "./effect-table.js";
import type { EffectTableEffect, EffectTableOp } from "./effect-table-types.js";
import { RESUME_KIND, type ResumeKind } from "./runtime-abi.js";
import {
  MIN_EFFECT_BUFFER_SIZE,
  MSGPACK_READ_VALUE,
  MSGPACK_WRITE_EFFECT,
  MSGPACK_WRITE_VALUE,
  VALUE_TAG,
} from "./host-boundary.js";

const TABLE_HEADER_SIZE = 12;
const EFFECT_HEADER_SIZE = 16;
const OP_ENTRY_SIZE = 12;
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

export interface ParsedEffectTable {
  version: number;
  tableExport: string;
  names: Uint8Array;
  namesBase64: string;
  effects: EffectTableEffect[];
  opsByEffect: Map<number, EffectTableOp[]>;
}

export interface EffectHandlerRequest {
  effectId: number;
  opId: number;
  resumeKind: ResumeKind;
  label: string;
  effectLabel: string;
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
  if (version !== 1) {
    throw new Error(`Unsupported effect table version ${version}`);
  }
  const effectCount = read();
  const opCount = read();

  const effectHeaders = Array.from({ length: effectCount }, () => ({
    effectId: read(),
    nameOffset: read(),
    opsOffset: read(),
    opCount: read(),
  }));

  const opEntries = Array.from({ length: opCount }, () => ({
    opId: read(),
    resumeKind: read(),
    nameOffset: read(),
  }));

  const namesStart =
    TABLE_HEADER_SIZE +
    effectHeaders.length * EFFECT_HEADER_SIZE +
    opEntries.length * OP_ENTRY_SIZE;
  if (namesStart > payload.length) {
    throw new Error("Effect table payload is truncated");
  }
  const names = payload.slice(namesStart);
  const namesBase64 = Buffer.from(names).toString("base64");

  const opsByEffect = new Map<number, EffectTableOp[]>();
  const effects: EffectTableEffect[] = effectHeaders.map((header) => {
    if (header.opsOffset % OP_ENTRY_SIZE !== 0) {
      throw new Error("Effect table op offset is misaligned");
    }
    const start = header.opsOffset / OP_ENTRY_SIZE;
    const end = start + header.opCount;
    if (end > opEntries.length) {
      throw new Error("Effect table op range exceeds table bounds");
    }
    const ops = opEntries.slice(start, end).map((op) => ({
      id: op.opId,
      name: decodeName(names, op.nameOffset),
      label: decodeName(names, op.nameOffset),
      resumeKind: parseResumeKind(op.resumeKind),
    }));
    opsByEffect.set(header.effectId, ops);
    return {
      id: header.effectId,
      name: decodeName(names, header.nameOffset),
      label: decodeName(names, header.nameOffset),
      ops,
    };
  });

  return {
    version,
    tableExport,
    names,
    namesBase64,
    effects,
    opsByEffect,
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

const lookupHandler = ({
  handlers,
  request,
}: {
  handlers?: Record<string, EffectHandler>;
  request: EffectHandlerRequest & { opLabel: string };
}): EffectHandler | undefined => {
  if (!handlers) return undefined;
  const kind = resumeKindName(request.resumeKind);
  return (
    handlers[`${request.effectId}:${request.opId}:${request.resumeKind}`] ??
    handlers[`${request.effectLabel}.${request.opLabel}/${kind}`] ??
    handlers[`${request.effectLabel}.${request.opLabel}`]
  );
};

const toEffectHandlerRequest = ({
  table,
  effectId,
  opId,
  resumeKind,
}: {
  table: ParsedEffectTable;
  effectId: number;
  opId: number;
  resumeKind: ResumeKind;
}): EffectHandlerRequest & { opLabel: string } => {
  const effect = table.effects.find((entry) => entry.id === effectId);
  const effectLabel = effect?.label ?? `effect#${effectId}`;
  const opLabel =
    effect?.ops.find((op) => op.id === opId)?.label ??
    `${effectLabel}.op#${opId}`;
  return {
    effectId,
    opId,
    resumeKind,
    label: opLabel,
    effectLabel,
    opLabel,
  };
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
          effectId: number,
          opId: number,
          resumeKind: number,
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
              effectId,
              opId,
              resumeKind,
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

  const bufferPtr = 0;
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
        effectId: number;
        opId: number;
        resumeKind: number;
        args: unknown[];
      };
      const resumeKind = parseResumeKind(decoded.resumeKind);
      const request = toEffectHandlerRequest({
        table,
        effectId: decoded.effectId,
        opId: decoded.opId,
        resumeKind,
      });
      const handler = lookupHandler({ handlers, request });
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
