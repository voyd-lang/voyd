import type binaryen from "binaryen";
import type { TypeId } from "../../../semantics/ids.js";

export type EffectOpSignature = {
  opIndex: number;
  effectId: bigint;
  opId: number;
  resumeKind: number;
  signatureHash: number;
  params: readonly binaryen.Type[];
  paramTypeIds: readonly TypeId[];
  returnType: binaryen.Type;
  returnTypeId: TypeId;
  argsType?: binaryen.Type;
  label: string;
};
