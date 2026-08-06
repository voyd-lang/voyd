import type { SymbolTable } from "../binder/index.js";
import type { DeclTable } from "../decls.js";
import type { HirFunction, HirGraph, HirLambdaExpr } from "../hir/index.js";
import type { HirExprId, SymbolId } from "../ids.js";
import type { TypingResult } from "../typing/index.js";
import type { SymbolRef } from "../typing/symbol-ref.js";
import {
  incrementCompilerPerfCounter,
  markCompilerPerfPhaseDuration,
  startCompilerPerfPhase,
} from "../../perf.js";
import type { CallableBorrowContract } from "./model.js";
import { callableContractHasGuardableAccessPair } from "./model.js";
import type { CallableBorrowIndex } from "./callable-borrow-index.js";
import {
  classifyCallableCapabilities,
  type ImportedCallableCapability,
} from "./capability-classifier.js";
import { joinLoanAnalysisModes, type LoanAnalysisMode } from "./capability.js";
import type { CapabilityDecision } from "./capability.js";
import { composeTransientCallableContract } from "./transient-contract.js";
import type { BorrowingDependency } from "./dependency.js";
import type { ResolveContext } from "./call-resolution.js";
import {
  createLazyCallableBorrowFacts,
  type CallableBorrowFacts,
} from "./callable-facts.js";
import {
  callableBorrowContractsEqual,
  computeCallableBorrowContracts,
  type CallableBorrowContractComputation,
} from "./summaries.js";
import type { CallableResultProvenance } from "./result-provenance.js";
import type { BorrowingResult } from "./model.js";
import {
  borrowQueryInputsEqual,
  persistedBorrowQueryOutput,
} from "./query-digest.js";

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
  resultProvenance,
  knownLocalCapabilities = new Map(),
}: {
  indexes: ReadonlyMap<SymbolId, CallableBorrowIndex>;
  localModuleId: string;
  declaredContracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  importedCallables: ReadonlyMap<string, ImportedCallableCapability>;
  localCallables: Map<SymbolId, ImportedCallableCapability>;
  initialContracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  initialCompactContracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  resultProvenance: ReadonlyMap<SymbolId, CallableResultProvenance>;
  knownLocalCapabilities?: ReadonlyMap<SymbolId, LoanAnalysisMode>;
}): TransientRoutingResult => {
  let decisions = classifyCallableCapabilities({
    indexes,
    localModuleId,
    declaredContracts,
    importedCallables,
    localCallables,
    knownLocalCapabilities,
    resultProvenance,
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
  let changedSymbols = new Set<SymbolId>();
  const maximumIterations = Math.max(4, indexes.size * 4 + 4);
  while (changed) {
    iterations += 1;
    if (iterations > maximumIterations) {
      changedSymbols.forEach((symbol) => compactContractFallbacks.add(symbol));
      decisions = classifyCallableCapabilities({
        indexes,
        localModuleId,
        declaredContracts,
        importedCallables,
        localCallables,
        knownLocalCapabilities: capabilities,
        compactContractFallbacks,
        resultProvenance,
      });
      decisions.forEach((decision, symbol) => {
        capabilities.set(
          symbol,
          joinLoanAnalysisModes([
            capabilities.get(symbol) ?? "none",
            decision.mode,
          ]),
        );
      });
      compactFallbacks = compactContractFallbacks.size;
      break;
    }
    changed = false;
    changedSymbols = new Set();
    Array.from(indexes)
      .filter(([symbol]) => capabilities.get(symbol) === "transient")
      .forEach(([symbol, index]) => {
        const candidate = composeTransientCallableContract({
          index,
          declaredContract: declaredContracts.get(symbol),
          resultProvenance: resultProvenance.get(symbol),
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
            changedSymbols.add(symbol);
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
        changedSymbols.add(symbol);
      });

    decisions = classifyCallableCapabilities({
      indexes,
      localModuleId,
      declaredContracts,
      importedCallables,
      localCallables,
      knownLocalCapabilities: capabilities,
      compactContractFallbacks,
      resultProvenance,
    });
    decisions.forEach((decision, symbol) => {
      const current = capabilities.get(symbol) ?? "none";
      const joined = joinLoanAnalysisModes([current, decision.mode]);
      if (joined !== current) {
        capabilities.set(symbol, joined);
        changed = true;
        changedSymbols.add(symbol);
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

export type BorrowingContractInferenceResult = TransientRoutingResult & {
  inferred: CallableBorrowContractComputation;
  functionFacts: ReadonlyMap<SymbolId, CallableBorrowFacts>;
  lambdaFacts: ReadonlyMap<HirExprId, CallableBorrowFacts>;
  flowFunctions: readonly HirFunction[];
  flowLambdas: readonly HirLambdaExpr[];
  materializedFacts: number;
};

/**
 * Owns monotonic capability routing and full-contract convergence. Full facts
 * are added lazily when a callable first reaches the flow-sensitive tier and
 * retained for every later inference pass and for diagnostic checking.
 */
export const inferBorrowingContracts = ({
  hir,
  typing,
  symbolTable,
  moduleId,
  imports,
  dependencies,
  decls,
  resolveContext,
  functions,
  lambdas,
  indexes,
  declaredContracts,
  importedCallables,
  localCallables,
  initialContracts,
  initialCompactContracts,
  fullInitialContracts,
  resultProvenance,
  previousQueries,
  retainIncrementalData = true,
}: {
  hir: HirGraph;
  typing: TypingResult;
  symbolTable: SymbolTable;
  moduleId: string;
  imports: readonly { local: SymbolId; target?: SymbolRef }[];
  dependencies: ReadonlyMap<string, BorrowingDependency>;
  decls: DeclTable;
  resolveContext: ResolveContext;
  functions: readonly HirFunction[];
  lambdas: readonly HirLambdaExpr[];
  indexes: ReadonlyMap<SymbolId, CallableBorrowIndex>;
  declaredContracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  importedCallables: ReadonlyMap<string, ImportedCallableCapability>;
  localCallables: Map<SymbolId, ImportedCallableCapability>;
  initialContracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  initialCompactContracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  fullInitialContracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  resultProvenance: ReadonlyMap<SymbolId, CallableResultProvenance>;
  previousQueries?: BorrowingResult["queries"];
  retainIncrementalData?: boolean;
}): BorrowingContractInferenceResult => {
  let routing = inferTransientBorrowingRouting({
    indexes,
    localModuleId: moduleId,
    declaredContracts,
    importedCallables,
    localCallables,
    initialContracts,
    initialCompactContracts,
    resultProvenance,
  });
  let capabilities = new Map(routing.capabilities);
  let contracts = new Map(routing.contracts);
  const functionFactCache = new Map<SymbolId, CallableBorrowFacts>();
  const lambdaFactCache = new Map<HirExprId, CallableBorrowFacts>();
  let functionFacts: ReadonlyMap<SymbolId, CallableBorrowFacts> = new Map();
  let lambdaFacts: ReadonlyMap<HirExprId, CallableBorrowFacts> = new Map();
  let flowFunctions: readonly HirFunction[] = [];
  let flowLambdas: readonly HirLambdaExpr[] = [];
  let inferred!: CallableBorrowContractComputation;
  let dirtyFlowSymbols: ReadonlySet<SymbolId> | undefined;
  const maximumRoutingPasses = Math.max(2, indexes.size + 1);

  for (
    let routingPass = 1;
    routingPass <= maximumRoutingPasses;
    routingPass += 1
  ) {
    const flowInitialContracts = new Map(contracts);
    if (routingPass === 1) {
      indexes.forEach((_index, symbol) => {
        if (capabilities.get(symbol) !== "flow-sensitive") return;
        flowInitialContracts.set(
          symbol,
          declaredContracts.get(symbol) ?? fullInitialContracts.get(symbol)!,
        );
      });
    }
    flowFunctions = functions.filter(
      (functionItem) =>
        capabilities.get(functionItem.symbol) === "flow-sensitive",
    );
    flowLambdas = lambdas.filter(
      (lambda) =>
        capabilities.get((-1 - lambda.id) as SymbolId) === "flow-sensitive",
    );
    const flowSymbols = new Set<SymbolId>([
      ...flowFunctions.map((functionItem) => functionItem.symbol),
      ...flowLambdas.map((lambda) => (-1 - lambda.id) as SymbolId),
    ]);
    const lazyFacts = createLazyCallableBorrowFacts({
      functions: flowFunctions,
      lambdas: flowLambdas,
      hir,
      typing,
      resolveContext: {
        ...resolveContext,
        contracts,
        callResolutionCache: new Map(),
      },
      functionCache: functionFactCache,
      lambdaCache: lambdaFactCache,
      collectStableInput: retainIncrementalData,
    });
    functionFacts = lazyFacts.functions;
    lambdaFacts = lazyFacts.lambdas;
    const dirtyFromPrevious = dirtySymbolsFromQueries({
      moduleId,
      facts: new Map([
        ...functionFacts,
        ...Array.from(
          lambdaFacts.values(),
          (facts) => [facts.symbol, facts] as const,
        ),
      ]),
      previousQueries,
      contracts,
      dependencies,
    });
    if (routingPass === 1 && previousQueries) {
      previousQueries.forEach((query, symbol) => {
        if (!dirtyFromPrevious.has(symbol) && flowSymbols.has(symbol)) {
          flowInitialContracts.set(symbol, query.output);
          contracts.set(symbol, query.output);
          localCallables.set(symbol, {
            capability: capabilities.get(symbol),
            contract: query.output,
          });
        }
      });
    }
    const inferStartedAt = startCompilerPerfPhase();
    inferred = computeCallableBorrowContracts({
      hir,
      typing,
      symbolTable,
      moduleId,
      imports,
      dependencies,
      decls,
      declarationContracts: declaredContracts,
      facts: functionFacts,
      lambdaFacts,
      initialContracts: flowInitialContracts,
      flowSymbols,
      collectQueries: retainIncrementalData,
      collectDemandTelemetry: retainIncrementalData,
      dirtySymbols:
        routingPass === 1 && previousQueries
          ? dirtyFromPrevious
          : dirtyFlowSymbols,
    });
    markCompilerPerfPhaseDuration(
      "analyzeBorrowing.inferContracts",
      inferStartedAt,
    );
    const inferredContracts = new Map<SymbolId, CallableBorrowContract>([
      ...inferred.contracts,
      ...Array.from(
        inferred.lambdaContracts,
        ([exprId, contract]) => [(-1 - exprId) as SymbolId, contract] as const,
      ),
    ]);
    inferredContracts.forEach((contract, symbol) => {
      localCallables.set(symbol, {
        capability: capabilities.get(symbol),
        contract,
      });
    });
    const routedContracts = new Map(contracts);
    inferredContracts.forEach((contract, symbol) =>
      routedContracts.set(symbol, contract),
    );
    const routedCompactContracts = new Map(routing.compactContracts);
    inferredContracts.forEach((contract, symbol) =>
      routedCompactContracts.set(symbol, contract),
    );
    const nextRouting = inferTransientBorrowingRouting({
      indexes,
      localModuleId: moduleId,
      declaredContracts,
      importedCallables,
      localCallables,
      initialContracts: routedContracts,
      initialCompactContracts: routedCompactContracts,
      resultProvenance,
      knownLocalCapabilities: capabilities,
    });
    const promotedSymbols = new Set(
      Array.from(nextRouting.capabilities).flatMap(([symbol, mode]) =>
        mode === "flow-sensitive" && capabilities.get(symbol) !== mode
          ? [symbol]
          : [],
      ),
    );
    const changedSymbols = new Set(
      Array.from(nextRouting.contracts).flatMap(([symbol, contract]) => {
        const previous = contracts.get(symbol);
        return nextRouting.capabilities.get(symbol) !== "flow-sensitive" &&
          (previous === undefined ||
            !callableBorrowContractsEqual(previous, contract))
          ? [symbol]
          : [];
      }),
    );
    promotedSymbols.forEach((symbol) => changedSymbols.add(symbol));
    const changed = changedSymbols.size > 0;
    routing = nextRouting;
    capabilities = new Map(nextRouting.capabilities);
    contracts = new Map(nextRouting.contracts);
    if (!changed) break;
    dirtyFlowSymbols = changedSymbols;
    if (routingPass === maximumRoutingPasses) {
      throw new Error(
        `borrowing capability routing did not converge after ${maximumRoutingPasses} passes`,
      );
    }
  }

  const functionSymbols = new Set(functions.map((item) => item.symbol));
  inferred = {
    ...inferred,
    contracts: new Map(
      Array.from(contracts).filter(([symbol]) => functionSymbols.has(symbol)),
    ),
    lambdaContracts: new Map(
      lambdas.flatMap((lambda) => {
        const contract = contracts.get((-1 - lambda.id) as SymbolId);
        return contract ? [[lambda.id, contract] as const] : [];
      }),
    ),
  };
  const nonFlowFactSymbols = [
    ...functionFactCache.keys(),
    ...Array.from(lambdaFactCache.values(), (facts) => facts.symbol),
  ].filter((symbol) => capabilities.get(symbol) !== "flow-sensitive");
  if (nonFlowFactSymbols.length > 0) {
    throw new Error(
      `borrowing architecture violation: full facts materialized for ${nonFlowFactSymbols.join(", ")}`,
    );
  }
  return {
    ...routing,
    capabilities,
    contracts,
    compactContracts: routing.compactContracts,
    inferred,
    functionFacts,
    lambdaFacts,
    flowFunctions,
    flowLambdas,
    materializedFacts: functionFactCache.size + lambdaFactCache.size,
  };
};

const dirtySymbolsFromQueries = ({
  moduleId,
  facts,
  previousQueries,
  contracts,
  dependencies,
}: {
  moduleId: string;
  facts: ReadonlyMap<SymbolId, CallableBorrowFacts>;
  previousQueries: BorrowingResult["queries"];
  contracts: ReadonlyMap<SymbolId, CallableBorrowContract>;
  dependencies: ReadonlyMap<string, BorrowingDependency>;
}): ReadonlySet<SymbolId> => {
  if (!previousQueries) return new Set(facts.keys());
  const dependencyOutput = (
    dependency: SymbolRef,
  ): CallableBorrowContract | null =>
    dependency.moduleId === moduleId
      ? (contracts.get(dependency.symbol) ?? null)
      : (dependencies.get(dependency.moduleId)?.callables.get(dependency.symbol)
          ?.contract ??
        dependencies
          .get(dependency.moduleId)
          ?.traitMethodContracts.get(dependency.symbol) ??
        null);
  const dirty = new Set(
    Array.from(facts).flatMap(([symbol, callableFacts]) => {
      const previous = previousQueries.get(symbol);
      const previousDependencyOutputs = new Map(
        previous?.dependencyOutputs ?? [],
      );
      const currentDependencies = new Map(
        [...callableFacts.dependencies, ...(previous?.dependencies ?? [])].map(
          (dependency) => [
            `${dependency.moduleId}:${dependency.symbol}`,
            dependency,
          ],
        ),
      );
      const changedDependency = Array.from(currentDependencies).some(
        ([key, dependency]) => {
          const previousOutput = previousDependencyOutputs.get(key);
          const currentOutput = dependencyOutput(dependency);
          if (typeof previousOutput === "string") {
            return previousOutput !== persistedBorrowQueryOutput(currentOutput);
          }
          if (!previousOutput || !currentOutput) {
            return previousOutput !== currentOutput;
          }
          return !callableBorrowContractsEqual(previousOutput, currentOutput);
        },
      );
      if (!previous) {
        return [symbol];
      }
      return !callableFacts.stableInput ||
        !borrowQueryInputsEqual(previous.input, callableFacts.stableInput) ||
        changedDependency
        ? [symbol]
        : [];
    }),
  );
  let changed = true;
  while (changed) {
    changed = false;
    facts.forEach((callableFacts, symbol) => {
      if (dirty.has(symbol)) return;
      const dependsOnDirty = callableFacts.dependencies.some(
        (dependency) =>
          dependency.moduleId === moduleId && dirty.has(dependency.symbol),
      );
      if (!dependsOnDirty) return;
      dirty.add(symbol);
      changed = true;
    });
  }
  return dirty;
};
