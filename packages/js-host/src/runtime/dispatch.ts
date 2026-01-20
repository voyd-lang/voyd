import { decode, encode } from "@msgpack/msgpack";
import type { EffectHandler } from "../protocol/types.js";
import type { ParsedEffectTable } from "../protocol/table.js";
import {
  EFFECT_RESULT_STATUS,
  MSGPACK_READ_VALUE,
  MSGPACK_WRITE_EFFECT,
  MSGPACK_WRITE_VALUE,
  RESUME_KIND,
  VALUE_TAG,
} from "./constants.js";

const MSGPACK_OPTS = { useBigInt64: true } as const;

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
    if (encoded.length > len) {
      // eslint-disable-next-line no-console
      console.error("msgpack overflow", { len, needed: encoded.length });
      latestLength = 0;
      return -1;
    }
    latestLength = encoded.length;
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
          const args = Array.from({ length: argCount }, (_value, index) =>
            view.getInt32(argsPtr + index * 4, true)
          );
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

const parseResumeKind = (value: number): number => {
  if (value === RESUME_KIND.resume) return RESUME_KIND.resume;
  if (value === RESUME_KIND.tail) return RESUME_KIND.tail;
  throw new Error(`unsupported resume kind ${value}`);
};

const resumeKindName = (value: number): string =>
  value === RESUME_KIND.tail ? "tail" : "resume";

export const runEffectLoop = async <T = unknown>({
  entry,
  effectStatus,
  effectCont,
  resumeEffectful,
  table,
  handlersByOpIndex,
  msgpackMemory,
  msgpackHost,
  bufferPtr,
  bufferSize,
}: {
  entry: CallableFunction;
  effectStatus: CallableFunction;
  effectCont: CallableFunction;
  resumeEffectful: CallableFunction;
  table: ParsedEffectTable;
  handlersByOpIndex: Array<EffectHandler | undefined>;
  msgpackMemory: WebAssembly.Memory;
  msgpackHost: MsgPackHost;
  bufferPtr: number;
  bufferSize: number;
}): Promise<T> => {
  const decodeLast = (): unknown => {
    const length = msgpackHost.lastEncodedLength();
    if (length <= 0) {
      throw new Error("no msgpack payload written to buffer");
    }
    const bytes = new Uint8Array(msgpackMemory.buffer, bufferPtr, length);
    return decode(bytes, MSGPACK_OPTS);
  };

  let result = entry(bufferPtr, bufferSize);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const status = effectStatus(result) as number;
    if (status === EFFECT_RESULT_STATUS.value) {
      const decoded = decodeLast() as { value: T };
      return decoded.value;
    }

    if (status === EFFECT_RESULT_STATUS.effect) {
      const decoded = decodeLast() as {
        effectId: bigint;
        opId: number;
        opIndex: number;
        resumeKind: number;
        handle: number;
        args?: unknown[];
      };
      const resumeKind = parseResumeKind(decoded.resumeKind);
      const handle = decoded.handle;
      const opIndex =
        Number.isInteger(handle) && handle >= 0 && handle < table.ops.length
          ? handle
          : decoded.opIndex;
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
      if (decoded.opId !== opEntry.opId) {
        throw new Error(
          `Effect op id mismatch for ${opEntry.label} (expected ${opEntry.opId}, got ${decoded.opId})`
        );
      }
      if (resumeKind !== opEntry.resumeKind) {
        throw new Error(
          `Resume kind mismatch for ${opEntry.label} (expected ${opEntry.resumeKind}, got ${resumeKind})`
        );
      }
      const handler = handlersByOpIndex[opEntry.opIndex];
      if (!handler) {
        throw new Error(
          `Unhandled effect ${opEntry.label} (${resumeKindName(
            opEntry.resumeKind
          )})`
        );
      }
      const resumeValue = await handler(...(decoded.args ?? []));
      const encoded = encode(resumeValue, MSGPACK_OPTS) as Uint8Array;
      if (encoded.length > bufferSize) {
        throw new Error("resume payload exceeds buffer size");
      }
      new Uint8Array(msgpackMemory.buffer, bufferPtr, encoded.length).set(encoded);
      msgpackHost.recordLength(encoded.length);
      result = resumeEffectful(effectCont(result), bufferPtr, bufferSize);
      continue;
    }

    throw new Error(`unexpected effect status ${status}`);
  }
};
