export type EffectId = string;
export type OpId = number;
export type SignatureHash = string;
export type Handle = number;
export type ResumeKind = "resume" | "tail";

export type RunOutcome<T = unknown> =
  | { kind: "value"; value: T }
  | { kind: "failed"; error: Error }
  | { kind: "cancelled"; reason?: unknown };

export type VoydRunHandle<T = unknown> = {
  id: string;
  outcome: Promise<RunOutcome<T>>;
  cancel: (reason?: unknown) => boolean;
};

export type EffectContinuationKind = "resume" | "tail" | "end";

export type EffectHandler<
  TArgs extends unknown[] = unknown[],
  TResult = unknown,
> = (
  continuation: EffectContinuation,
  ...args: TArgs
) => EffectContinuationCall<TResult> | Promise<EffectContinuationCall<TResult>>;

export type EffectContinuationCall<TResult = unknown> = {
  readonly kind: EffectContinuationKind;
  readonly value: TResult;
};

export type EffectContinuation = {
  resume: (...args: unknown[]) => EffectContinuationCall;
  tail: (...args: unknown[]) => EffectContinuationCall;
  end: (result: unknown) => EffectContinuationCall;
};

export type EffectDescriptor = {
  opIndex: number;
  effectId: EffectId;
  opId: OpId;
  opName: string;
  resumeKind: ResumeKind;
  signatureHash: SignatureHash;
  label?: string;
};

export type HostProtocolTable = {
  version: number;
  ops: EffectDescriptor[];
};
