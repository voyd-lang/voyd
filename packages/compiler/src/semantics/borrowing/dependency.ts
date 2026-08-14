import type { SymbolId } from "../ids.js";
import type { FunctionSignature } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type { OrdinaryMutationSummary } from "./ordinary-mutation-summary.js";
import type { ResultIdentity } from "../../result-identity.js";

export type BorrowingCallableDependency = {
  name: string;
  signature?: FunctionSignature;
  resultIdentity?: ResultIdentity;
};

export type BorrowingDependency = {
  callables: ReadonlyMap<SymbolId, BorrowingCallableDependency>;
  ordinaryMutationSummaries: ReadonlyMap<SymbolId, OrdinaryMutationSummary>;
  defaultIdentityGuardTargets: ReadonlySet<SymbolId>;
  effectOperations: ReadonlyMap<SymbolId, { maySuspend: boolean }>;
  /** Imported symbols known to be open trait-method declarations. */
  traitMethodDeclarations: ReadonlyMap<SymbolId, SymbolRef>;
};
