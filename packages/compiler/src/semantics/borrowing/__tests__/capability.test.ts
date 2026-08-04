import { describe, expect, it } from "vitest";
import {
  capabilityDecision,
  conservativeCapabilityDecision,
  joinCapabilityDecisions,
  joinLoanAnalysisModes,
} from "../capability.js";
import {
  classifyCallableCapability,
  type CapabilityClassifierInput,
} from "../capability-classifier.js";
import type { CallableBorrowIndex } from "../callable-borrow-index.js";

const openDispatchIndex = (): CallableBorrowIndex =>
  ({
    symbol: 1,
    parameters: [],
    parameterPlaces: new Map(),
    accesses: [],
    calls: [],
    directCallEdges: [],
    flags: {
      hasBorrowOperation: false,
      hasBorrowedBinding: false,
      hasBorrowedReturn: false,
      hasBorrowedStore: false,
      hasUnsafeBorrowFormation: false,
      hasMutableParameter: false,
      hasMutableBinding: false,
      hasNonFreshMutableBinding: false,
      hasReferenceBinding: false,
      hasRetainedReferenceStore: false,
      hasMutableReferenceRebinding: false,
      hasNonFreshMutableReferenceRebinding: false,
      hasCapture: false,
      hasRetention: false,
      hasSuspension: false,
      hasModuleStorageAccess: false,
      hasModuleStorageWrite: false,
      hasModuleStorageBorrow: false,
      hasUnresolvedBehavior: false,
      hasOpenDispatch: false,
      hasUnknownBehavior: false,
      hasDefaultArgument: false,
      hasDefaultBorrowFlow: false,
      hasRuntimeCheckedReceiverWrites: false,
      hasAllocationResult: false,
      hasResultProvenanceTrigger: false,
      hasTraitResult: false,
      hasCallableResult: false,
      hasReturnedParameterValue: false,
    },
  }) as CallableBorrowIndex;

describe("borrow capability lattice", () => {
  it("joins modes monotonically", () => {
    expect(joinLoanAnalysisModes([])).toBe("none");
    expect(joinLoanAnalysisModes(["none", "transient"])).toBe("transient");
    expect(joinLoanAnalysisModes(["transient", "flow-sensitive", "none"])).toBe(
      "flow-sensitive",
    );
  });

  it("joins decisions and preserves unique reasons", () => {
    expect(
      joinCapabilityDecisions([
        capabilityDecision("transient", ["borrow"]),
        capabilityDecision("flow-sensitive", ["borrow", "capture"]),
      ]),
    ).toEqual({
      mode: "flow-sensitive",
      reasons: ["borrow", "capture"],
    });
  });

  it("uses a flow-sensitive conservative fallback for unknown behavior", () => {
    expect(conservativeCapabilityDecision("unknown-call")).toEqual({
      mode: "flow-sensitive",
      reasons: ["unknown-call"],
    });
  });

  it("routes open dispatch through the flow-sensitive path", () => {
    const input: CapabilityClassifierInput = {
      index: openDispatchIndex(),
      localModuleId: "test",
      localCapabilities: new Map(),
      importedCallables: new Map(),
      dispatch: { hasOpenDispatch: true },
    };
    expect(classifyCallableCapability(input).mode).toBe("flow-sensitive");
  });
});
