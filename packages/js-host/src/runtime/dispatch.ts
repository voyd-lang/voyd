import { decode, encode } from "@msgpack/msgpack";
import type { EffectHandler } from "../protocol/types.js";
import type { ParsedEffectTable } from "../protocol/table.js";
import {
  EFFECT_RESULT_STATUS,
  RESUME_KIND,
} from "./constants.js";
import { isNoResume } from "./no-resume.js";

const MSGPACK_OPTS = { useBigInt64: true } as const;

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
  effectLen,
  resumeEffectful,
  table,
  handlersByOpIndex,
  msgpackMemory,
  bufferPtr,
  bufferSize,
}: {
  entry: CallableFunction;
  effectStatus: CallableFunction;
  effectCont: CallableFunction;
  effectLen: CallableFunction;
  resumeEffectful: CallableFunction;
  table: ParsedEffectTable;
  handlersByOpIndex: Array<EffectHandler | undefined>;
  msgpackMemory: WebAssembly.Memory;
  bufferPtr: number;
  bufferSize: number;
}): Promise<T> => {
  let result = entry(bufferPtr, bufferSize);

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
      return decoded as T;
    }

    if (status === EFFECT_RESULT_STATUS.effect) {
      const decodedEffect = decoded as {
        effectId: bigint;
        opId: number;
        opIndex: number;
        resumeKind: number;
        handle: number;
        args?: unknown[];
      };
      const resumeKind = parseResumeKind(decodedEffect.resumeKind);
      const handle = decodedEffect.handle;
      const opIndex =
        Number.isInteger(handle) && handle >= 0 && handle < table.ops.length
          ? handle
          : decodedEffect.opIndex;
      const opEntry = table.ops[opIndex];
      if (!opEntry) {
        throw new Error(`Unknown effect op index ${decodedEffect.opIndex}`);
      }
      const decodedEffectId =
        typeof decodedEffect.effectId === "bigint"
          ? BigInt.asUintN(64, decodedEffect.effectId)
          : undefined;
      if (
        typeof decodedEffectId === "bigint" &&
        decodedEffectId !== opEntry.effectIdHash.value
      ) {
        throw new Error(
          `Effect id mismatch for opIndex ${opEntry.opIndex} (expected ${opEntry.effectIdHash.hex})`
        );
      }
      if (decodedEffect.opIndex !== opEntry.opIndex) {
        throw new Error(
          `Effect op index mismatch for handle ${handle} (expected ${opEntry.opIndex}, got ${decodedEffect.opIndex})`
        );
      }
      if (decodedEffect.opId !== opEntry.opId) {
        throw new Error(
          `Effect op id mismatch for ${opEntry.label} (expected ${opEntry.opId}, got ${decodedEffect.opId})`
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
          `Unhandled effect ${opEntry.label} (${resumeKindName(opEntry.resumeKind)})`
        );
      }
      const handlerResult = await handler(...(decodedEffect.args ?? []));
      if (isNoResume(handlerResult)) {
        if (resumeKind === RESUME_KIND.tail) {
          throw new Error(`Missing tail resumption for ${opEntry.label}`);
        }
        return handlerResult.value as T;
      }

      const encoded = encode(handlerResult, MSGPACK_OPTS) as Uint8Array;
      if (encoded.length > bufferSize) {
        throw new Error("resume payload exceeds buffer size");
      }
      new Uint8Array(msgpackMemory.buffer, bufferPtr, encoded.length).set(encoded);
      result = resumeEffectful(effectCont(result), bufferPtr, encoded.length, bufferSize);
      continue;
    }

    throw new Error(`unexpected effect status ${status}`);
  }
};
