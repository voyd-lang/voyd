import type { FunctionMetadata } from "../context.js";
import type { TypeId } from "../../semantics/ids.js";

export type HostTransportIdentity = {
  readonly id: string;
  readonly version: number;
};

export type HostTransportProviderFunctions = {
  readerTypeId: TypeId;
  writerTypeId: TypeId;
  createReader: FunctionMetadata;
  readerComplete: FunctionMetadata;
  createWriter: FunctionMetadata;
  finishWriter: FunctionMetadata;
};
