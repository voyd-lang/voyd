import type binaryen from "binaryen";

export type MsgPackImports = {
  writeValue: string;
  writeEffect: string;
  readValue: string;
};

export type EffectOpSignature = {
  opIndex: number;
  effectId: bigint;
  opId: number;
  resumeKind: number;
  signatureHash: number;
  params: readonly binaryen.Type[];
  returnType: binaryen.Type;
  argsType?: binaryen.Type;
  label: string;
};
