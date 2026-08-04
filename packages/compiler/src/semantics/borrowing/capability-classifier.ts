import type { SymbolId } from "../ids.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import type { CallableBorrowContract } from "./model.js";
import {
  capabilityDecision,
  conservativeCapabilityDecision,
  joinCapabilityDecisions,
  joinLoanAnalysisModes,
  type CapabilityDecision,
  type LoanAnalysisMode,
} from "./capability.js";
import type {
  CallableBorrowIndex,
  CallableBorrowIndexCall,
} from "./callable-borrow-index.js";
import type { CallableResultProvenance } from "./result-provenance.js";
import {
  callableResultHasOwnedRoot,
  callableResultIsOwned,
} from "./result-provenance.js";

export type ImportedCallableCapability = {
  capability?: LoanAnalysisMode;
  contract?: CallableBorrowContract;
};

export type CapabilityClassifierInput = {
  index: CallableBorrowIndex;
  localModuleId: string;
  declaredContract?: CallableBorrowContract;
  localCapabilities: ReadonlyMap<SymbolId, LoanAnalysisMode>;
  importedCallables: ReadonlyMap<string, ImportedCallableCapability>;
  localCallables?: ReadonlyMap<SymbolId, ImportedCallableCapability>;
  compactContractFallback?: boolean;
  resultProvenance?: CallableResultProvenance;
  dispatch?: {
    hasOpenDispatch?: boolean;
    hasUnresolvedDispatch?: boolean;
  };
};

const keyFor = (target: SymbolRef): string =>
  `${target.moduleId}:${target.symbol}`;

const contractHasCompactEffect = (contract: CallableBorrowContract): boolean =>
  contract.externalRead === true ||
  contract.externalWrite === true ||
  contract.parameters.some(
    (parameter) =>
      parameter.access !== "owned" ||
      (parameter.readPaths?.length ?? 0) > 0 ||
      (parameter.writePaths?.length ?? 0) > 0,
  );

const contractHasEscapingResult = (contract: CallableBorrowContract): boolean =>
  contract.borrowedResult !== "none" ||
  contract.externalReturnedOrigins?.some((origin) => origin.fresh !== true) ===
    true ||
  contract.parameters.some(
    (parameter) =>
      parameter.returned === true ||
      parameter.returnedAggregate === true ||
      (parameter.returnedOrigins?.length ?? 0) > 0 ||
      (parameter.returnedPaths?.length ?? 0) > 0 ||
      (parameter.returnedSharedOrigins?.length ?? 0) > 0 ||
      (parameter.returnedTypeMatchingOrigins?.length ?? 0) > 0 ||
      parameter.accessIfResultTypeDiffers !== undefined,
  );

const contractHasRetainedInput = (contract: CallableBorrowContract): boolean =>
  contract.parameters.some(
    (parameter) =>
      (parameter.access !== "owned" && parameter.retained === true) ||
      (parameter.access !== "owned" &&
        ((parameter.retainedPaths?.length ?? 0) > 0 ||
          (parameter.externalRetainedPaths?.length ?? 0) > 0 ||
          (parameter.borrowedRetainedPaths?.length ?? 0) > 0)),
  ) ||
  (contract.transfers?.length ?? 0) > 0 ||
  (contract.scopedCallbacks?.length ?? 0) > 0 ||
  (contract.callableResultInvocations?.length ?? 0) > 0;

const contractHasDefaultFlow = (
  contract: CallableBorrowContract,
  call: CallableBorrowIndexCall,
): boolean =>
  call.arguments.some((argument) => {
    if (argument.defaulted !== true) return false;
    const parameter = contract.parameters[argument.parameter];
    if (!parameter) return true;
    return (
      (parameter.defaultOrigins?.length ?? 0) > 0 ||
      (parameter.defaultReadOrigins?.length ?? 0) > 0 ||
      (parameter.defaultWriteOrigins?.length ?? 0) > 0 ||
      (parameter.defaultExternalOrigins?.length ?? 0) > 0 ||
      (parameter.defaultExternalReturnedOrigins?.length ?? 0) > 0 ||
      parameter.defaultExternalRead === true ||
      parameter.defaultExternalWrite === true ||
      parameter.defaultBorrowedResult !== "none"
    );
  });

const callHasBorrowRelevantBoundary = (
  call: CallableBorrowIndexCall,
): boolean =>
  call.formsExplicitBorrow ||
  call.returnsBorrowed ||
  call.resultUse === "escapes-or-ambiguous" ||
  call.arguments.some((argument) => argument.loanBearing === true);

const calleeEffectDecision = ({
  call,
  mode,
  contract,
}: {
  call: CallableBorrowIndexCall;
  mode: LoanAnalysisMode | undefined;
  contract?: CallableBorrowContract;
}): CapabilityDecision => {
  const loanArgument = call.arguments.some(
    (argument) => argument.loanBearing === true,
  );
  const referenceArgument = call.arguments.some(
    (argument) => argument.referenceCapable === true,
  );
  if (mode === undefined) {
    // A resolved value-only call cannot form or propagate a caller loan even
    // when its body contract is not indexed (for example, a synthesized
    // scalar operator). Loan-bearing arguments, borrowed results, and
    // explicit borrow calls remain conservative unknown behavior.
    if (
      (call.signature !== undefined || call.intrinsic) &&
      !loanArgument &&
      !call.returnsBorrowed &&
      !call.formsExplicitBorrow
    ) {
      return capabilityDecision("none", ["known-value-callee"]);
    }
    return conservativeCapabilityDecision("unknown-callee");
  }
  const loanArgumentRequiresOwnership = call.arguments.some(
    (argument, parameterIndex) => {
      if (argument.loanBearing !== true) return false;
      const parameter = contract?.parameters[parameterIndex];
      const signatureParameter = call.signature?.parameters[parameterIndex];
      return (
        (parameter?.access === "mutable" &&
          signatureParameter?.bindingKind !== "mutable-ref" &&
          signatureParameter?.bindingKind !== "immutable-ref") ||
        parameter?.retained === true ||
        parameter?.returned === true ||
        (parameter?.retainedPaths?.length ?? 0) > 0 ||
        (parameter?.returnedPaths?.length ?? 0) > 0 ||
        (parameter?.returnedOrigins?.length ?? 0) > 0
      );
    },
  );
  if (!contract) {
    if (call.arguments.some((argument) => argument.defaulted === true)) {
      return conservativeCapabilityDecision("unknown-default-flow");
    }
    if (mode === "none") return capabilityDecision("none");
    if (mode === "flow-sensitive") {
      if (call.resultUse !== "escapes-or-ambiguous" && !loanArgument) {
        return call.formsExplicitBorrow
          ? capabilityDecision("transient", ["callee-borrow"])
          : capabilityDecision("none", ["callee"]);
      }
      return conservativeCapabilityDecision("flow-callee-without-contract");
    }
    return capabilityDecision("transient", ["callee"]);
  }
  if (contractHasDefaultFlow(contract, call)) {
    return capabilityDecision("flow-sensitive", ["callee-default-flow"]);
  }
  if (loanArgumentRequiresOwnership) {
    return capabilityDecision("flow-sensitive", ["callee-loan-ownership"]);
  }
  const resultEscapes = call.resultUse === "escapes-or-ambiguous";
  const resultRequiresFlow =
    contract.borrowedResult !== "none" ||
    contract.externalReturnedOrigins?.some(
      (origin) => origin.fresh !== true,
    ) === true ||
    (referenceArgument && contractHasEscapingResult(contract));
  const invalidatedProjection = contract.parameters.some(
    (parameter, parameterIndex) =>
      parameter.invalidatedPaths?.some((path) => path.length === 0) === true &&
      call.arguments[parameterIndex]?.place?.projections.some(
        (projection) => projection.kind !== "identity",
      ) === true,
  );
  if (invalidatedProjection) {
    return capabilityDecision("flow-sensitive", [
      "invalidated-projected-place",
    ]);
  }
  if (
    (resultRequiresFlow && resultEscapes) ||
    (loanArgument && contractHasRetainedInput(contract))
  ) {
    return capabilityDecision("flow-sensitive", ["callee-loan-escape"]);
  }
  if (mode === "none") return capabilityDecision("none");
  return contractHasCompactEffect(contract) || call.formsExplicitBorrow
    ? capabilityDecision("transient", ["callee-compact-effect"])
    : capabilityDecision("none");
};

export const classifyBorrowContractCapability = (
  contract: CallableBorrowContract | undefined,
): CapabilityDecision => {
  if (!contract) return conservativeCapabilityDecision("unknown-contract");
  if (
    contract.maySuspend ||
    contract.borrowedResult === "parameter" ||
    contract.borrowedResult === "external" ||
    contract.externalReturnedOrigins?.some(
      (origin) => origin.fresh !== true,
    ) === true ||
    (contract.transfers?.length ?? 0) > 0 ||
    (contract.scopedCallbacks?.length ?? 0) > 0 ||
    (contract.callableResultInvocations?.length ?? 0) > 0 ||
    contract.dynamicDispatch !== undefined
  ) {
    return capabilityDecision("flow-sensitive", ["contract-flow"]);
  }
  const flowParameter = contract.parameters.some(
    (parameter) =>
      parameter.access !== "owned" &&
      (parameter.retained ||
        parameter.returned === true ||
        (parameter.returnedPaths?.length ?? 0) > 0 ||
        (parameter.returnedOrigins?.length ?? 0) > 0 ||
        parameter.returnedAggregate === true ||
        (parameter.retainedPaths?.length ?? 0) > 0 ||
        (parameter.externalRetainedPaths?.length ?? 0) > 0 ||
        (parameter.borrowedRetainedPaths?.length ?? 0) > 0 ||
        (parameter.returnedSharedOrigins?.length ?? 0) > 0 ||
        (parameter.returnedTypeMatchingOrigins?.length ?? 0) > 0 ||
        parameter.accessIfResultTypeDiffers !== undefined ||
        (parameter.invalidatedPaths?.length ?? 0) > 0 ||
        (parameter.defaultOrigins?.length ?? 0) > 0 ||
        parameter.defaultExternalReturnedOrigins?.some(
          (origin) => origin.fresh !== true,
        ) === true),
  );
  if (flowParameter) {
    return capabilityDecision("flow-sensitive", ["contract-flow"]);
  }
  const transient = contract.parameters.some(
    (parameter) =>
      parameter.access !== "owned" ||
      (parameter.readPaths?.length ?? 0) > 0 ||
      (parameter.writePaths?.length ?? 0) > 0,
  );
  return capabilityDecision(transient ? "transient" : "none", [
    ...(transient ? ["contract-access"] : []),
  ]);
};

const targetDecision = ({
  target,
  call,
  index,
  localModuleId,
  localCapabilities,
  importedCallables,
  localCallables,
}: {
  target: SymbolRef;
  call: CallableBorrowIndexCall;
  index: CallableBorrowIndex;
  localModuleId: string;
  localCapabilities: ReadonlyMap<SymbolId, LoanAnalysisMode>;
  importedCallables: ReadonlyMap<string, ImportedCallableCapability>;
  localCallables?: ReadonlyMap<SymbolId, ImportedCallableCapability>;
}): CapabilityDecision => {
  if (target.moduleId === localModuleId) {
    const local = localCapabilities.get(target.symbol);
    const contract = localCallables?.get(target.symbol)?.contract;
    if (local !== undefined) {
      return calleeEffectDecision({ call, mode: local, contract });
    }
    const known = localCallables?.get(target.symbol);
    if (known?.capability !== undefined) {
      return calleeEffectDecision({
        call,
        mode: known.capability,
        contract: known.contract,
      });
    }
    if (known?.contract !== undefined) {
      return calleeEffectDecision({
        call,
        mode: classifyBorrowContractCapability(known.contract).mode,
        contract: known.contract,
      });
    }
    return calleeEffectDecision({ call, mode: undefined });
  }
  const imported = importedCallables.get(keyFor(target));
  if (imported?.capability !== undefined) {
    return calleeEffectDecision({
      call,
      mode: imported.capability,
      contract: imported.contract,
    });
  }
  if (imported?.contract !== undefined) {
    return calleeEffectDecision({
      call,
      mode: classifyBorrowContractCapability(imported.contract).mode,
      contract: imported.contract,
    });
  }
  if (index.flags.hasUnknownBehavior) {
    return conservativeCapabilityDecision("unknown-callee");
  }
  return conservativeCapabilityDecision("unresolved-callee");
};

/** The only HIR-free capability classifier. */
export const classifyCallableCapability = ({
  index,
  localModuleId,
  declaredContract,
  localCapabilities,
  importedCallables,
  localCallables,
  compactContractFallback,
  resultProvenance,
  dispatch,
}: CapabilityClassifierInput): CapabilityDecision => {
  const decisions: CapabilityDecision[] = [];
  const hasDirectReferenceAccess = index.accesses.some((access) => {
    if (!access.place) return false;
    const parameter = index.parameterPlaces.get(access.place.root);
    if (parameter === undefined) return false;
    return index.parameters[parameter.parameter]?.loanBearing === true;
  });
  const hasCompactAccessFootprint = index.accesses.some(
    (access) =>
      access.kind === "write" || (access.place?.projections.length ?? 0) > 0,
  );
  const hasReturnedBorrowParameter = index.flags.hasReturnedParameterValue;
  const hasBorrowedDefaultParameter =
    index.flags.hasDefaultArgument &&
    index.parameters.some((parameter) => parameter.loanBearing === true);
  const allocationResultNeedsFullFacts =
    index.flags.hasAllocationResult &&
    !callableResultHasOwnedRoot(resultProvenance) &&
    !index.parameters.some((parameter) => parameter.loanBearing === true);
  const hasBorrowRelevantOpenDispatch = index.calls.some(
    (call) =>
      (call.openTraitDispatch === true ||
        call.argumentPlanAmbiguous === true) &&
      callHasBorrowRelevantBoundary(call),
  );
  if (declaredContract) {
    decisions.push(classifyBorrowContractCapability(declaredContract));
  }
  if (index.flags.hasUnknownBehavior) {
    decisions.push(conservativeCapabilityDecision("unknown-behavior"));
  }
  if (compactContractFallback) {
    decisions.push(conservativeCapabilityDecision("compact-contract-fallback"));
  }
  if (
    hasBorrowRelevantOpenDispatch ||
    dispatch?.hasOpenDispatch ||
    dispatch?.hasUnresolvedDispatch
  ) {
    decisions.push(conservativeCapabilityDecision("open-dispatch"));
  }
  if (
    index.flags.hasBorrowedReturn ||
    index.flags.hasBorrowedBinding ||
    index.flags.hasBorrowedStore ||
    index.flags.hasRetainedReferenceStore ||
    index.flags.hasNonFreshMutableReferenceRebinding ||
    index.flags.hasNonFreshMutableBinding ||
    index.flags.hasUnsafeBorrowFormation ||
    index.flags.hasRetention ||
    index.flags.hasModuleStorageBorrow ||
    index.flags.hasCapture ||
    index.flags.hasTraitResult ||
    index.flags.hasCallableResult ||
    (index.flags.hasResultProvenanceTrigger &&
      !callableResultIsOwned(resultProvenance)) ||
    allocationResultNeedsFullFacts ||
    hasReturnedBorrowParameter ||
    (index.flags.hasReferenceBinding && index.flags.hasBorrowOperation) ||
    index.flags.hasDefaultBorrowFlow ||
    hasBorrowedDefaultParameter ||
    (index.flags.hasSuspension &&
      (index.parameters.some((parameter) => parameter.loanBearing === true) ||
        index.flags.hasBorrowedBinding ||
        index.flags.hasModuleStorageBorrow ||
        index.flags.hasCapture))
  ) {
    decisions.push(
      capabilityDecision("flow-sensitive", [
        ...(index.flags.hasBorrowedReturn ? ["returned-borrow"] : []),
        ...(index.flags.hasBorrowedBinding ? ["borrowed-binding"] : []),
        ...(index.flags.hasBorrowedStore ? ["retained-borrow"] : []),
        ...(index.flags.hasRetainedReferenceStore
          ? ["retained-reference-store"]
          : []),
        ...(index.flags.hasNonFreshMutableBinding
          ? ["non-fresh-mutable-binding"]
          : []),
        ...(index.flags.hasUnsafeBorrowFormation
          ? ["unsafe-borrow-formation"]
          : []),
        ...(index.flags.hasRetention ? ["retention"] : []),
        ...(index.flags.hasSuspension ? ["suspension"] : []),
        ...(index.flags.hasModuleStorageBorrow ? ["module-storage"] : []),
        ...(index.flags.hasCapture ? ["capture"] : []),
        ...(index.flags.hasTraitResult ? ["trait-result"] : []),
        ...(index.flags.hasCallableResult ? ["callable-result"] : []),
        ...(index.flags.hasResultProvenanceTrigger &&
        !callableResultIsOwned(resultProvenance)
          ? ["result-provenance-trigger"]
          : []),
        ...(allocationResultNeedsFullFacts ? ["allocation-result"] : []),
        ...(hasReturnedBorrowParameter ? ["returned-parameter-value"] : []),
        ...(index.flags.hasReferenceBinding ? ["reference-binding"] : []),
        ...(index.flags.hasDefaultBorrowFlow ? ["default-borrow-flow"] : []),
        ...(hasBorrowedDefaultParameter ? ["borrowed-default"] : []),
      ]),
    );
  } else if (
    index.flags.hasBorrowOperation ||
    index.flags.hasMutableBinding ||
    hasDirectReferenceAccess ||
    hasCompactAccessFootprint ||
    index.flags.hasModuleStorageAccess
  ) {
    decisions.push(
      capabilityDecision("transient", [
        ...(index.flags.hasMutableParameter ? ["mutable-parameter"] : []),
        ...(index.flags.hasMutableBinding ? ["mutable-binding"] : []),
        ...(index.flags.hasBorrowOperation ? ["borrow-operation"] : []),
        ...(hasDirectReferenceAccess ? ["reference-access"] : []),
        ...(index.flags.hasModuleStorageAccess ? ["module-storage-read"] : []),
      ]),
    );
  }
  index.calls.forEach((call) => {
    if (
      call.maySuspend &&
      (index.flags.hasBorrowedBinding ||
        index.flags.hasModuleStorageBorrow ||
        index.flags.hasCapture ||
        index.parameters.some((parameter) => parameter.loanBearing === true))
    ) {
      decisions.push(
        capabilityDecision("flow-sensitive", ["callee-suspension"]),
      );
    }
    if (call.targets.length === 0 && !call.intrinsic) {
      decisions.push(calleeEffectDecision({ call, mode: undefined }));
      return;
    }
    call.targets.forEach((target) =>
      decisions.push(
        targetDecision({
          target,
          call,
          index,
          localModuleId,
          localCapabilities,
          importedCallables,
          localCallables,
        }),
      ),
    );
  });
  if (decisions.length === 0) return capabilityDecision("none");
  return joinCapabilityDecisions(decisions);
};

export const classifyCallableCapabilities = ({
  indexes,
  localModuleId,
  declaredContracts,
  importedCallables,
  localCallables,
  dispatch = new Map(),
  knownLocalCapabilities = new Map(),
  compactContractFallbacks = new Set(),
  resultProvenance = new Map(),
}: {
  indexes: ReadonlyMap<SymbolId, CallableBorrowIndex>;
  localModuleId: string;
  declaredContracts?: ReadonlyMap<SymbolId, CallableBorrowContract>;
  importedCallables: ReadonlyMap<string, ImportedCallableCapability>;
  localCallables?: ReadonlyMap<SymbolId, ImportedCallableCapability>;
  dispatch?: ReadonlyMap<SymbolId, CapabilityClassifierInput["dispatch"]>;
  knownLocalCapabilities?: ReadonlyMap<SymbolId, LoanAnalysisMode>;
  compactContractFallbacks?: ReadonlySet<SymbolId>;
  resultProvenance?: ReadonlyMap<SymbolId, CallableResultProvenance>;
}): ReadonlyMap<SymbolId, CapabilityDecision> => {
  const modes = new Map<SymbolId, LoanAnalysisMode>();
  knownLocalCapabilities.forEach((mode, symbol) => modes.set(symbol, mode));
  indexes.forEach((index) => {
    if (!modes.has(index.symbol)) modes.set(index.symbol, "none");
  });
  const decisions = new Map<SymbolId, CapabilityDecision>();
  indexes.forEach((index) => {
    const prior = modes.get(index.symbol) ?? "none";
    const decision = classifyCallableCapability({
      index,
      localModuleId,
      declaredContract: declaredContracts?.get(index.symbol),
      localCapabilities: modes,
      importedCallables,
      localCallables,
      compactContractFallback: compactContractFallbacks.has(index.symbol),
      resultProvenance: resultProvenance.get(index.symbol),
      dispatch: dispatch.get(index.symbol),
    });
    const joined = joinLoanAnalysisModes([prior, decision.mode]);
    modes.set(index.symbol, joined);
    decisions.set(
      index.symbol,
      joinCapabilityDecisions([capabilityDecision(joined), decision]),
    );
  });
  return decisions;
};
