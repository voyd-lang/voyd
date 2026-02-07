import type {
  EffectContinuation,
  EffectContinuationCall,
  EffectContinuationKind,
} from "../protocol/types.js";

const CONTINUATION_CALL_BRAND = Symbol.for("voyd.effect.continuation.call");

type BrandedEffectContinuationCall = EffectContinuationCall & {
  readonly [CONTINUATION_CALL_BRAND]: true;
};

const valueFromArgs = (args: unknown[]): unknown =>
  args.length <= 1 ? args[0] : args;

const createCall = (
  kind: EffectContinuationKind,
  value: unknown
): BrandedEffectContinuationCall => ({
  [CONTINUATION_CALL_BRAND]: true,
  kind,
  value,
});

export const createEffectContinuation = (): EffectContinuation => ({
  resume: (...args) => createCall("resume", valueFromArgs(args)),
  tail: (...args) => createCall("tail", valueFromArgs(args)),
  end: (value) => createCall("end", value),
});

export const isEffectContinuationCall = (
  value: unknown
): value is EffectContinuationCall => {
  if (!value || typeof value !== "object") return false;
  return (
    (value as Record<symbol, unknown>)[CONTINUATION_CALL_BRAND] === true
  );
};
