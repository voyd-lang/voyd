import type { SymbolId } from "../ids.js";
import type { FunctionSignature } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type { CallableBorrowContract } from "./model.js";
import type { PlaceProjection } from "./model.js";
import type { LoanAnalysisMode } from "./capability.js";
import type {
  CallableBorrowDispatchKind,
  CallableBorrowSummarySource,
  PublicNamedBorrowContract,
} from "./callable-summary.js";

export type BorrowingCallableDependency = {
  name?: string;
  signature?: FunctionSignature;
  capability?: LoanAnalysisMode;
  contract?: CallableBorrowContract;
  dispatch?: CallableBorrowDispatchKind;
  namedContract?: PublicNamedBorrowContract;
  source?: CallableBorrowSummarySource;
};

export type BorrowingDependency = {
  callables: ReadonlyMap<SymbolId, BorrowingCallableDependency>;
  effectOperations: ReadonlyMap<SymbolId, { maySuspend: boolean }>;
  traitMethodDeclarations: ReadonlyMap<SymbolId, SymbolRef>;
  traitMethodContracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  traitRegionProjections: readonly {
    concrete: SymbolRef;
    trait: SymbolRef;
    implementation: SymbolRef;
    source: readonly PlaceProjection[];
    result: Extract<PlaceProjection, { kind: "region" }>;
  }[];
};
