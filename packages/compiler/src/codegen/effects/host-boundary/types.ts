import type binaryen from "binaryen";
import type { TypeId } from "../../../semantics/ids.js";
import type { SourceSpan } from "../../../diagnostics/types.js";
import type { SerializerMetadata } from "../../../semantics/symbol-index.js";
import type { BoundarySchema } from "../../boundary/schema.js";

export type EffectOpSignature = {
  opIndex: number;
  effectId: bigint;
  effectIdentity: string;
  opId: number;
  resumeKind: number;
  signatureHash: number;
  params: readonly binaryen.Type[];
  paramTypeIds: readonly TypeId[];
  paramFingerprints: readonly string[];
  paramSerializerOverrides?: readonly (SerializerMetadata | undefined)[];
  returnType: binaryen.Type;
  returnTypeId: TypeId;
  resultFingerprint: string;
  returnSerializerOverride?: SerializerMetadata;
  argsType?: binaryen.Type;
  label: string;
  span: SourceSpan;
  externalBoundary?: {
    params: readonly BoundarySchema[];
    result: BoundarySchema;
  };
};
