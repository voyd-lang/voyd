import type { CodegenContext, FunctionMetadata } from "../context.js";
import type { ProgramSymbolId, TypeId } from "../../semantics/ids.js";

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

export type HostTransportProviderDescriptor = {
  readonly identity: HostTransportIdentity;
  ensureFunctions(ctx: CodegenContext): HostTransportProviderFunctions;
  enqueueReachability(args: {
    ctx: CodegenContext;
    enqueue: (symbol: ProgramSymbolId) => void;
  }): void;
};
