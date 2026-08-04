import type { SymbolId } from "../ids.js";
import { incrementCompilerPerfCounter } from "../../perf.js";
import type { CallableBorrowContract } from "./model.js";
import { callableContractHasGuardableAccessPair } from "./model.js";
import type { CallableBorrowIndex } from "./callable-borrow-index.js";
import {
  classifyCallableCapabilities,
  type ImportedCallableCapability,
} from "./capability-classifier.js";
import {
  joinLoanAnalysisModes,
  type LoanAnalysisMode,
} from "./capability.js";
import type { CapabilityDecision } from "./capability.js";
import { composeTransientCallableContract } from "./transient-contract.js";

export type TransientRoutingResult = {
  capabilities: ReadonlyMap<SymbolId, LoanAnalysisMode>;
  decisions: ReadonlyMap<SymbolId, CapabilityDecision>;
  contracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  compactContracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  compactFallbacks: number;
  iterations: number;
};

/**
 * The contract-routing owner coordinates the monotonic compact solve. The
 * capability classifier remains the only routing rule implementation; this
 * module only feeds published compact contracts back into that classifier and
 * promotes a callable when compact composition cannot prove its boundary.
 */
export const inferTransientBorrowingRouting = ({
  indexes,
  localModuleId,
  declaredContracts,
  importedCallables,
  localCallables,
  initialContracts,
  initialCompactContracts,
}: {
  indexes: ReadonlyMap<SymbolId, CallableBorrowIndex>;
  localModuleId: string;
  declaredContracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  importedCallables: ReadonlyMap<string, ImportedCallableCapability>;
  localCallables: Map<SymbolId, ImportedCallableCapability>;
  initialContracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  initialCompactContracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
}): TransientRoutingResult => {
  let decisions = classifyCallableCapabilities({
    indexes,
    localModuleId,
    declaredContracts,
    importedCallables,
    localCallables,
  });
  const capabilities = new Map<SymbolId, LoanAnalysisMode>(
    Array.from(decisions, ([symbol, decision]) => [symbol, decision.mode]),
  );
  const contracts = new Map(initialContracts);
  const compactContracts = new Map(initialCompactContracts);
  let compactFallbacks = 0;
  const compactContractFallbacks = new Set<SymbolId>();
  let iterations = 0;
  let changed = true;
  const maximumIterations = Math.max(4, indexes.size * 4 + 4);
  while (changed) {
    iterations += 1;
    if (iterations > maximumIterations) {
      throw new Error(
        `borrowing compact contract inference did not converge after ${maximumIterations} iterations`,
      );
    }
    changed = false;
    Array.from(indexes)
      .filter(([symbol]) => capabilities.get(symbol) === "transient")
      .forEach(([symbol, index]) => {
        const candidate = composeTransientCallableContract({
          index,
          declaredContract: declaredContracts.get(symbol),
          lookup: {
            localModuleId,
            localCapabilities: capabilities,
            localContracts: compactContracts,
            importedCallables,
          },
        });
        incrementCompilerPerfCounter("borrowing.contract.compactEvaluations");
        if (!candidate) {
          if (!compactContractFallbacks.has(symbol)) {
            compactContractFallbacks.add(symbol);
            compactFallbacks += 1;
            changed = true;
          }
          return;
        }
        const previous = contracts.get(symbol);
        const publishedCandidate =
          previous?.defaultIdentityGuardProtocol !== undefined &&
          callableContractHasGuardableAccessPair(candidate)
            ? {
                ...candidate,
                defaultIdentityGuardProtocol:
                  previous.defaultIdentityGuardProtocol,
              }
            : candidate;
        if (JSON.stringify(previous) === JSON.stringify(publishedCandidate)) {
          return;
        }
        compactContracts.set(symbol, publishedCandidate);
        contracts.set(symbol, publishedCandidate);
        localCallables.set(symbol, {
          ...localCallables.get(symbol),
          contract: publishedCandidate,
        });
        changed = true;
      });

    decisions = classifyCallableCapabilities({
      indexes,
      localModuleId,
      declaredContracts,
      importedCallables,
      localCallables,
      knownLocalCapabilities: capabilities,
      compactContractFallbacks,
    });
    decisions.forEach((decision, symbol) => {
      const current = capabilities.get(symbol) ?? "none";
      const joined = joinLoanAnalysisModes([current, decision.mode]);
      if (joined !== current) {
        capabilities.set(symbol, joined);
        changed = true;
      }
    });
  }
  return {
    capabilities,
    decisions,
    contracts,
    compactContracts,
    compactFallbacks,
    iterations,
  };
};
