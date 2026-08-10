import type {
  EffectHandler,
  EffectResourceCleanup,
} from "../protocol/types.js";
import type { ParsedEffectTable } from "../protocol/table.js";
import {
  resolveParsedEffectOp,
  resumeKindName,
  type EffectOpRequest,
} from "../effect-op.js";
import { EFFECT_RESULT_STATUS, RESUME_KIND } from "./constants.js";
import {
  createEffectContinuation,
  isEffectContinuationCall,
} from "./continuation.js";
import type {
  VoydRuntimeEffectContext,
  VoydRuntimeTransitionContext,
} from "./trap-diagnostics.js";
import type { HostTransportAdapter } from "../protocol/host-transport.js";

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

export type HostCompletionIdentity =
  | { kind: "export"; id: number }
  | { kind: "callback"; id: number };

export const decodeHostCompletion = ({
  memory,
  ptr,
  length,
  transport,
  completion,
}: {
  memory: WebAssembly.Memory;
  ptr: number;
  length: number;
  transport: HostTransportAdapter;
  completion: HostCompletionIdentity;
}): unknown => {
  const bytes = new Uint8Array(memory.buffer, ptr, length);
  const frame = transport.decodeFrame(bytes);
  if (completion.kind === "export") {
    if (
      frame.kind !== "export-completion" ||
      frame.exportId !== completion.id
    ) {
      throw new Error(
        "effect boundary returned an incompatible completion frame",
      );
    }
  } else if (
    frame.kind !== "callback-completion" ||
    frame.invocationId !== completion.id
  ) {
    throw new Error(
      "effect boundary returned an incompatible completion frame",
    );
  }
  const outcome = frame.outcome;
  if (outcome.kind === "failure") {
    throw new Error(outcome.failure.message);
  }
  return outcome.value.value;
};

const invalidPayloadLengthMessage = ({
  status,
  payloadLength,
  bufferSize,
}: {
  status: number;
  payloadLength: number;
  bufferSize: number;
}): string => {
  const kind =
    status === EFFECT_RESULT_STATUS.value
      ? "value"
      : status === EFFECT_RESULT_STATUS.effect
        ? "effect request"
        : `status ${status}`;
  return `effect boundary ${kind} payload encoding failed (len=${payloadLength}, bufferSize=${bufferSize}); increase createVoydHost({ bufferSize })`;
};

const nonReturningHandlerMessage = (label: string): string =>
  `Effect handler for ${label} must return a continuation call (return resume(...), tail(...), or end(...))`;

const invalidTailHandlerMessage = (label: string): string =>
  `Tail effect ${label} must return tail(...)`;

const invalidResumeHandlerMessage = (label: string): string =>
  `Resume effect ${label} cannot return tail(...) (return resume(...) or end(...))`;

const normalizedEffectLabel = (label: string): string => {
  const dot = label.lastIndexOf(".");
  if (dot < 0) return label;
  return `${label.slice(0, dot)}::${label.slice(dot + 1)}`;
};

const opNameFromLabel = (label: string): string => {
  const normalized = normalizedEffectLabel(label);
  const separator = normalized.lastIndexOf("::");
  if (separator < 0) {
    return normalized;
  }
  return normalized.slice(separator + 2);
};

const effectContextFor = ({
  opEntry,
  continuationBoundary,
}: {
  opEntry: ParsedEffectTable["ops"][number];
  continuationBoundary?: "resume" | "tail" | "end";
}): VoydRuntimeEffectContext => ({
  effectId: opEntry.effectId,
  opId: opEntry.opId,
  opName: opNameFromLabel(opEntry.label),
  label: normalizedEffectLabel(opEntry.label),
  resumeKind: resumeKindName(opEntry.resumeKind),
  ...(continuationBoundary ? { continuationBoundary } : {}),
});

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
  registerResourceCleanup,
  annotateTrap,
  fallbackFunctionName,
  transport,
  completion,
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
  registerResourceCleanup?: (cleanup: EffectResourceCleanup) => void;
  annotateTrap?: (
    error: unknown,
    opts: {
      effect?: VoydRuntimeEffectContext;
      transition?: VoydRuntimeTransitionContext;
      fallbackFunctionName?: string;
    },
  ) => Error;
  fallbackFunctionName?: string;
  transport: HostTransportAdapter;
  completion: HostCompletionIdentity;
}): Promise<EffectLoopStepResult<T>> => {
  const withTrapContext = ({
    error,
    transition,
    effect,
  }: {
    error: unknown;
    transition: VoydRuntimeTransitionContext;
    effect?: VoydRuntimeEffectContext;
  }): Error =>
    annotateTrap
      ? annotateTrap(error, {
          transition,
          effect,
          fallbackFunctionName,
        })
      : toError(error);

  let status: number;
  let payloadLength: number;
  try {
    status = effectStatus(result) as number;
    payloadLength = effectLen(result) as number;
  } catch (error) {
    throw withTrapContext({
      error,
      transition: {
        point: "effect_status",
        direction: "vm",
      },
    });
  }
  if (payloadLength <= 0 || payloadLength > bufferSize) {
    throw new Error(
      invalidPayloadLengthMessage({
        status,
        payloadLength,
        bufferSize,
      }),
    );
  }
  if (status === EFFECT_RESULT_STATUS.value) {
    return {
      kind: "value",
      value: decodeHostCompletion({
        memory: msgpackMemory,
        ptr: bufferPtr,
        length: payloadLength,
        transport,
        completion,
      }) as T,
    };
  }

  if (status === EFFECT_RESULT_STATUS.effect) {
    const frame = transport.decodeFrame(
      new Uint8Array(msgpackMemory.buffer, bufferPtr, payloadLength),
    );
    if (frame.kind !== "effect-request") {
      throw new Error("effect boundary returned an incompatible host frame");
    }
    const framedOp = table.ops[frame.requestId];
    if (
      !framedOp ||
      framedOp.effectId !== frame.effectId ||
      framedOp.opId !== frame.operationId ||
      framedOp.signatureHash !== frame.signatureHash >>> 0 ||
      framedOp.resumeKind !== frame.resumeKind
    ) {
      throw new Error("effect request frame does not match the effect table");
    }
    const decodedEffect: EffectOpRequest = {
      effectId: framedOp.effectIdHash.value,
      opId: framedOp.opId,
      opIndex: framedOp.opIndex,
      resumeKind: framedOp.resumeKind,
      handle: framedOp.opIndex,
      args: frame.args.map((payload) => payload.value),
    };
    const opEntry = resolveParsedEffectOp({
      table,
      request: decodedEffect,
    });
    const handler = handlersByOpIndex[opEntry.opIndex];
    if (!handler) {
      throw new Error(
        `Unhandled effect ${opEntry.label} (${resumeKindName(opEntry.resumeKind)})`,
      );
    }
    const continuation = createEffectContinuation({ registerResourceCleanup });
    const handlerResult = await handler(
      continuation,
      ...(decodedEffect.args ?? []),
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

    const encoded = transport.encodeFrame({
      kind: "effect-outcome",
      requestId: frame.requestId,
      outcome: {
        kind: "success",
        value: {
          fingerprint: frame.resultFingerprint,
          value: handlerResult.value,
        },
      },
    });
    if (encoded.length > bufferSize) {
      throw new Error("resume payload exceeds buffer size");
    }
    new Uint8Array(msgpackMemory.buffer, bufferPtr, encoded.length).set(
      encoded,
    );
    let resumed: unknown;
    try {
      resumed = resumeEffectful(
        effectCont(result),
        bufferPtr,
        encoded.length,
        bufferSize,
        completion.kind === "export" ? 0 : 1,
        completion.id,
      );
    } catch (error) {
      throw withTrapContext({
        error,
        transition: {
          point: "resume_effectful",
          direction: "host->vm",
        },
        effect: effectContextFor({
          opEntry,
          continuationBoundary: handlerResult.kind,
        }),
      });
    }
    return {
      kind: "next",
      result: resumed,
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
  transport,
  completion,
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
  transport: HostTransportAdapter;
  completion: HostCompletionIdentity;
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
      transport,
      completion,
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
