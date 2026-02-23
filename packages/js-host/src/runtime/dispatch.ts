import { decode, encode } from "@msgpack/msgpack";
import type { EffectHandler } from "../protocol/types.js";
import type { ParsedEffectTable } from "../protocol/table.js";
import {
  resolveParsedEffectOp,
  resumeKindName,
  type EffectOpRequest,
} from "../effect-op.js";
import {
  EFFECT_RESULT_STATUS,
  RESUME_KIND,
} from "./constants.js";
import {
  createEffectContinuation,
  isEffectContinuationCall,
} from "./continuation.js";

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

const nonReturningHandlerMessage = (label: string): string =>
  `Effect handler for ${label} must return a continuation call (return resume(...), tail(...), or end(...))`;

const invalidTailHandlerMessage = (label: string): string =>
  `Tail effect ${label} must return tail(...)`;

const invalidResumeHandlerMessage = (label: string): string =>
  `Resume effect ${label} cannot return tail(...) (return resume(...) or end(...))`;

export type EffectLoopStepResult<T = unknown> =
  | { kind: "next"; result: unknown }
  | { kind: "aborted" }
  | { kind: "value"; value: T };

export const continueEffectLoopStep = async <T = unknown>({
  result,
  effectStatus,
  effectCont,
  effectLen,
  resumeEffectful,
  table,
  handlersByOpIndex,
  msgpackMemory,
  bufferPtr,
  bufferSize,
  shouldContinue = () => true,
}: {
  result: unknown;
  effectStatus: CallableFunction;
  effectCont: CallableFunction;
  effectLen: CallableFunction;
  resumeEffectful: CallableFunction;
  table: ParsedEffectTable;
  handlersByOpIndex: Array<EffectHandler | undefined>;
  msgpackMemory: WebAssembly.Memory;
  bufferPtr: number;
  bufferSize: number;
  shouldContinue?: () => boolean;
}): Promise<EffectLoopStepResult<T>> => {
  const status = effectStatus(result) as number;
  const payloadLength = effectLen(result) as number;
  const decoded = decodePayload({
    memory: msgpackMemory,
    ptr: bufferPtr,
    length: payloadLength,
  });

  if (status === EFFECT_RESULT_STATUS.value) {
    return { kind: "value", value: decoded as T };
  }

  if (status === EFFECT_RESULT_STATUS.effect) {
    const decodedEffect = decoded as EffectOpRequest;
    const opEntry = resolveParsedEffectOp({
      table,
      request: decodedEffect,
    });
    const handler = handlersByOpIndex[opEntry.opIndex];
    if (!handler) {
      throw new Error(
        `Unhandled effect ${opEntry.label} (${resumeKindName(opEntry.resumeKind)})`
      );
    }
    const continuation = createEffectContinuation();
    const handlerResult = await handler(
      continuation,
      ...(decodedEffect.args ?? [])
    );
    if (!shouldContinue()) {
      return { kind: "aborted" };
    }
    if (!isEffectContinuationCall(handlerResult)) {
      throw new Error(nonReturningHandlerMessage(opEntry.label));
    }
    if (
      opEntry.resumeKind === RESUME_KIND.tail &&
      handlerResult.kind !== "tail"
    ) {
      throw new Error(invalidTailHandlerMessage(opEntry.label));
    }
    if (
      opEntry.resumeKind === RESUME_KIND.resume &&
      handlerResult.kind === "tail"
    ) {
      throw new Error(invalidResumeHandlerMessage(opEntry.label));
    }
    if (handlerResult.kind === "end") {
      return { kind: "value", value: handlerResult.value as T };
    }
    if (handlerResult.kind !== "resume" && handlerResult.kind !== "tail") {
      throw new Error(nonReturningHandlerMessage(opEntry.label));
    }

    const encoded = encode(handlerResult.value, MSGPACK_OPTS) as Uint8Array;
    if (encoded.length > bufferSize) {
      throw new Error("resume payload exceeds buffer size");
    }
    new Uint8Array(msgpackMemory.buffer, bufferPtr, encoded.length).set(encoded);
    return {
      kind: "next",
      result: resumeEffectful(effectCont(result), bufferPtr, encoded.length, bufferSize),
    };
  }

  throw new Error(`unexpected effect status ${status}`);
};

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
    const stepResult = await continueEffectLoopStep<T>({
      result,
      effectStatus,
      effectCont,
      effectLen,
      resumeEffectful,
      table,
      handlersByOpIndex,
      msgpackMemory,
      bufferPtr,
      bufferSize,
    });
    if (stepResult.kind === "value") {
      return stepResult.value;
    }
    if (stepResult.kind === "aborted") {
      throw new Error("effect loop step aborted outside scheduler context");
    }
    result = stepResult.result;
  }
};
