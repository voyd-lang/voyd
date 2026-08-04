/**
 * The capability lattice is deliberately independent of HIR and analysis.
 * It is the routing contract between cheap callable indexing and the
 * capability-specific borrowing implementations.
 */
export type LoanAnalysisMode = "none" | "transient" | "flow-sensitive";

export type CapabilityDecision = {
  mode: LoanAnalysisMode;
  reasons: readonly string[];
};

const modeRank: Readonly<Record<LoanAnalysisMode, number>> = {
  none: 0,
  transient: 1,
  "flow-sensitive": 2,
};

export const joinLoanAnalysisModes = (
  modes: readonly LoanAnalysisMode[],
): LoanAnalysisMode =>
  modes.reduce<LoanAnalysisMode>(
    (current, candidate) =>
      modeRank[candidate] > modeRank[current] ? candidate : current,
    "none",
  );

export const joinCapabilityDecisions = (
  decisions: readonly CapabilityDecision[],
): CapabilityDecision => {
  const mode = joinLoanAnalysisModes(decisions.map((decision) => decision.mode));
  return {
    mode,
    reasons: Array.from(
      new Set(decisions.flatMap((decision) => decision.reasons)),
    ),
  };
};

export const conservativeCapabilityDecision = (
  reason = "unknown-behavior",
): CapabilityDecision => ({
  mode: "flow-sensitive",
  reasons: [reason],
});

export const capabilityDecision = (
  mode: LoanAnalysisMode,
  reasons: readonly string[] = [],
): CapabilityDecision => ({
  mode,
  reasons: Array.from(new Set(reasons)),
});
