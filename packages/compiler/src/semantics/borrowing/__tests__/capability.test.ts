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
import type {
  CallableBorrowIndex,
  CallableBorrowIndexCall,
} from "../callable-borrow-index.js";
import type { CallableBorrowContract } from "../model.js";
import { planRuntimeBorrowing } from "../transient-guards.js";
import type { TypingResult } from "../../typing/index.js";

const openDispatchIndex = (
  calls: readonly CallableBorrowIndexCall[] = [],
): CallableBorrowIndex =>
  ({
    symbol: 1,
    parameters: [],
    parameterPlaces: new Map(),
    accesses: [],
    calls,
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

  it("uses an authoritative declaration contract for open dispatch", () => {
    const contract = {
      parameters: [],
      maySuspend: false,
      borrowedResult: "none" as const,
      freshResult: true as const,
    };
    const index = openDispatchIndex([
      {
        exprId: 2,
        span: { file: "test.voyd", start: 0, end: 1 },
        targets: [{ moduleId: "test", symbol: 3 }],
        arguments: [],
        intrinsic: false,
        intrinsicBoundary: false,
        formsExplicitBorrow: false,
        returnsBorrowed: false,
        resultUse: "escapes-or-ambiguous",
        maySuspend: false,
        openTraitDispatch: true,
        boundaryContract: contract,
      },
    ]);
    expect(
      classifyCallableCapability({
        index,
        localModuleId: "test",
        localCapabilities: new Map(),
        importedCallables: new Map(),
      }),
    ).toEqual({ mode: "none", reasons: [] });
  });

  it("plans open-dispatch guards from the authoritative contract", () => {
    const boundaryContract: CallableBorrowContract = {
      parameters: [0, 1].map(() => ({
        access: "mutable" as const,
        writePaths: [[]],
        invalidatedPaths: [[]],
        retained: false,
        returned: false,
      })),
      maySuspend: false,
      borrowedResult: "none",
    };
    const implementationContract: CallableBorrowContract = {
      ...boundaryContract,
      parameters: boundaryContract.parameters.map((parameter) => ({
        ...parameter,
        writePaths: [],
        invalidatedPaths: [],
      })),
    };
    const call: CallableBorrowIndexCall = {
      exprId: 2,
      span: { file: "test.voyd", start: 0, end: 1 },
      targets: [{ moduleId: "test", symbol: 3 }],
      arguments: [
        { parameter: 0, expression: 4, place: { root: 10, projections: [] } },
        { parameter: 1, expression: 5, place: { root: 11, projections: [] } },
      ],
      signature: {
        parameters: [
          { bindingKind: "mutable-ref" },
          { bindingKind: "mutable-ref" },
        ],
      } as unknown as CallableBorrowIndexCall["signature"],
      intrinsic: false,
      intrinsicBoundary: false,
      formsExplicitBorrow: false,
      returnsBorrowed: false,
      resultUse: "ignored",
      maySuspend: false,
      openTraitDispatch: true,
      boundaryContract,
    };
    const plan = planRuntimeBorrowing({
      index: openDispatchIndex([call]),
      lookup: {
        localModuleId: "test",
        localCapabilities: new Map(),
        localContracts: new Map([[3, implementationContract]]),
        importedCallables: new Map(),
      },
      typing: {} as TypingResult,
    });

    expect(plan.guards.get(call.exprId)).toHaveLength(1);
  });
});
