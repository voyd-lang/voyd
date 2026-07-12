import type binaryen from "binaryen";
import type { TypeId } from "../../../semantics/ids.js";
import type { SourceSpan } from "../../../diagnostics/types.js";
import type { SerializerMetadata } from "../../../semantics/symbol-index.js";
import type { BoundarySchema } from "../../boundary/schema.js";

export type EffectOpSignature = {
  opIndex: number;
  effectId: bigint;
  opId: number;
  resumeKind: number;
  signatureHash: number;
  params: readonly binaryen.Type[];
  paramTypeIds: readonly TypeId[];
  paramSerializerOverrides?: readonly (SerializerMetadata | undefined)[];
  returnType: binaryen.Type;
  returnTypeId: TypeId;
  returnSerializerOverride?: SerializerMetadata;
  argsType?: binaryen.Type;
  label: string;
  span: SourceSpan;
  externalBoundary?: {
    params: readonly BoundarySchema[];
    result: BoundarySchema;
  };
};
