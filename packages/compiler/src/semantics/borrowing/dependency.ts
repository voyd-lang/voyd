import type { SymbolId } from "../ids.js";
import type { FunctionSignature } from "../typing/index.js";
import type { CallableBorrowContract } from "./model.js";
import type {
  CallableBorrowDispatchKind,
  CallableBorrowSummarySource,
  PublicNamedBorrowContract,
} from "./callable-summary.js";

export type BorrowingCallableDependency = {
  name?: string;
  signature?: FunctionSignature;
  contract?: CallableBorrowContract;
  dispatch?: CallableBorrowDispatchKind;
  namedContract?: PublicNamedBorrowContract;
  source?: CallableBorrowSummarySource;
};

export type BorrowingDependency = {
  callables: ReadonlyMap<SymbolId, BorrowingCallableDependency>;
  effectOperations: ReadonlyMap<SymbolId, { maySuspend: boolean }>;
};
