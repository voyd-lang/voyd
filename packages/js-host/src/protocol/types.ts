export type EffectId = string;
export type OpId = number;
export type SignatureHash = string;
export type Handle = number;
export type ResumeKind = "resume" | "tail";

export type NoResume<T = unknown> = {
  readonly value: T;
};

export type EffectHandlerResult = unknown | NoResume;

export type EffectHandler = (
  ...args: unknown[]
) => EffectHandlerResult | Promise<EffectHandlerResult>;

export type EffectDescriptor = {
  opIndex: number;
  effectId: EffectId;
  opId: OpId;
  resumeKind: ResumeKind;
  signatureHash: SignatureHash;
  label?: string;
};

export type HostProtocolTable = {
  version: number;
  ops: EffectDescriptor[];
};
