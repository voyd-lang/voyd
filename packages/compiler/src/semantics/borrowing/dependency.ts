import type { SymbolId } from "../ids.js";
import type { FunctionSignature } from "../typing/index.js";
import type { CallableBorrowContract } from "./model.js";

export type BorrowingCallableDependency = {
  name?: string;
  signature?: FunctionSignature;
  contract?: CallableBorrowContract;
};

export type BorrowingDependency = {
  callables: ReadonlyMap<SymbolId, BorrowingCallableDependency>;
  effectOperations: ReadonlyMap<SymbolId, { maySuspend: boolean }>;
};
