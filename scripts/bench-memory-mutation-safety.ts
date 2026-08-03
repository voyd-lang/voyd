import { cpus, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

type PerfSummary = {
  phasesMs: Record<string, number>;
  counters: Record<string, number>;
};

type CompileSuccess = {
  success: true;
  wasm: Uint8Array;
  wasmText?: string;
};

type CompileFailure = {
  success: false;
  diagnostics: readonly {
    code?: string;
    message?: string;
  }[];
};

const valueAfter = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const repository = resolve(valueAfter("--repo") ?? process.cwd());
const fixtureRepository = resolve(
  valueAfter("--fixture-repo") ?? process.cwd(),
);
const label = valueAfter("--label") ?? repository;
const sampleCount = Number.parseInt(valueAfter("--samples") ?? "7", 10);
const runtimeSampleCount = Number.parseInt(
  valueAfter("--runtime-samples") ?? "11",
  10,
);
if (sampleCount < 3 || runtimeSampleCount < 3) {
  throw new Error(
    "benchmark requires at least three compile and runtime samples",
  );
}

process.env.VOYD_COMPILER_PERF = "1";

const perfSummaries: PerfSummary[] = [];
const originalConsoleError = console.error;
console.error = (...args: unknown[]): void => {
  const line = args.map(String).join(" ");
  const marker = "[voyd:compiler:perf] ";
  if (!line.startsWith(marker)) {
    originalConsoleError(...args);
    return;
  }
  perfSummaries.push(JSON.parse(line.slice(marker.length)) as PerfSummary);
};

const sdkModule = (await import(
  pathToFileURL(resolve(repository, "packages/sdk/src/index.ts")).href
)) as {
  createSdk: () => {
    compile: (options: {
      entryPath: string;
      optimize: boolean;
      emitWasmText: boolean;
    }) => Promise<CompileSuccess | CompileFailure>;
  };
};
const hostModule = (await import(
  pathToFileURL(resolve(repository, "packages/js-host/src/index.ts")).href
)) as {
  createVoydHost: (options: { wasm: Uint8Array }) => Promise<{
    instance: WebAssembly.Instance;
    runPure: <T>(entryName: string) => Promise<T>;
  }>;
};

const fixtureEntryPath = resolve(
  repository,
  "tests/performance/fixtures/scalar-aggregate-representative.voyd",
);
const guardedFixtureEntryPath = resolve(
  fixtureRepository,
  "tests/performance/fixtures/memory-mutation-safety-guarded.voyd",
);
const median = (values: readonly number[]): number => {
  const ordered = [...values].sort((left, right) => left - right);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0
    ? (ordered[middle - 1]! + ordered[middle]!) / 2
    : ordered[middle]!;
};
const count = (source: string, pattern: RegExp): number =>
  Array.from(source.matchAll(pattern)).length;

const measureMode = async (optimize: boolean) => {
  const compileMs: number[] = [];
  const compilerTotalMs: number[] = [];
  const retainedContractCount: number[] = [];
  const retainedContractBytes: number[] = [];
  const factBlocks: number[] = [];
  const factOperations: number[] = [];
  const totalBodyCallables: number[] = [];
  const checkedBodyCallables: number[] = [];
  const dependencyAssemblyAvailableModules: number[] = [];
  const dependencyAssemblyDirectEdges: number[] = [];
  const dependencyAssemblyImportTargets: number[] = [];
  const dependencyAssemblyEdgeCandidates: number[] = [];
  const dependencyAssemblyProjectedModules: number[] = [];
  const dependencyProjectionCacheHits: number[] = [];
  const dependencyProjectionCacheMisses: number[] = [];
  const totalSummaryCallables: number[] = [];
  const demandedSummaryCallables: number[] = [];
  const skippedTrivialSummaryCallables: number[] = [];
  const summaryDemandWorklistEdges: number[] = [];
  const summaryDemandWorklistIterations: number[] = [];
  const summaryEvaluations: number[] = [];
  const summaryDemandReasons = new Map<string, number[]>();
  const borrowingContractComputationMs: number[] = [];
  const borrowingFactExtractionMs: number[] = [];
  const borrowingInferenceMs: number[] = [];
  const borrowingValidationMs: number[] = [];
  const borrowingBodySelectionMs: number[] = [];
  const borrowingLoanCheckingMs: number[] = [];
  let compiled: CompileSuccess | undefined;

  for (let sample = 0; sample < sampleCount; sample += 1) {
    const summaryIndex = perfSummaries.length;
    const startedAt = performance.now();
    const result = await sdkModule.createSdk().compile({
      entryPath: fixtureEntryPath,
      optimize,
      emitWasmText: true,
    });
    compileMs.push(performance.now() - startedAt);
    if (!result.success) {
      throw new Error(`benchmark compile failed: ${JSON.stringify(result)}`);
    }
    compiled = result;
    const summary = perfSummaries[summaryIndex];
    if (!summary) {
      throw new Error("compiler did not emit a performance summary");
    }
    compilerTotalMs.push(summary.phasesMs.total ?? compileMs.at(-1)!);
    retainedContractCount.push(
      summary.counters["borrowing.contract.retainedCount"] ?? 0,
    );
    retainedContractBytes.push(
      summary.counters["borrowing.contract.retainedBytes"] ?? 0,
    );
    factBlocks.push(summary.counters["borrowing.facts.blocks"] ?? 0);
    factOperations.push(summary.counters["borrowing.facts.operations"] ?? 0);
    totalBodyCallables.push(
      summary.counters["borrowing.body.totalCallables"] ?? 0,
    );
    checkedBodyCallables.push(
      summary.counters["borrowing.body.checkedCallables"] ?? 0,
    );
    dependencyAssemblyAvailableModules.push(
      summary.counters["borrowing.dependencyAssembly.availableModules"] ?? 0,
    );
    dependencyAssemblyDirectEdges.push(
      summary.counters["borrowing.dependencyAssembly.directEdges"] ?? 0,
    );
    dependencyAssemblyImportTargets.push(
      summary.counters["borrowing.dependencyAssembly.importTargets"] ?? 0,
    );
    dependencyAssemblyEdgeCandidates.push(
      summary.counters["borrowing.dependencyAssembly.edgeCandidates"] ?? 0,
    );
    dependencyAssemblyProjectedModules.push(
      summary.counters["borrowing.dependencyAssembly.projectedModules"] ?? 0,
    );
    dependencyProjectionCacheHits.push(
      summary.counters["borrowing.dependencyProjection.cacheHit"] ?? 0,
    );
    dependencyProjectionCacheMisses.push(
      summary.counters["borrowing.dependencyProjection.cacheMiss"] ?? 0,
    );
    totalSummaryCallables.push(
      summary.counters["borrowing.summary.totalCallables"] ?? 0,
    );
    demandedSummaryCallables.push(
      summary.counters["borrowing.summary.demandedCallables"] ?? 0,
    );
    skippedTrivialSummaryCallables.push(
      summary.counters["borrowing.summary.skippedTrivialCallables"] ?? 0,
    );
    summaryDemandWorklistEdges.push(
      summary.counters["borrowing.summary.demandWorklistEdges"] ?? 0,
    );
    summaryDemandWorklistIterations.push(
      summary.counters["borrowing.summary.demandWorklistIterations"] ?? 0,
    );
    summaryEvaluations.push(
      summary.counters["borrowing.summary.evaluations"] ?? 0,
    );
    Object.entries(summary.counters)
      .filter(([name]) => name.startsWith("borrowing.summary.demandReason."))
      .forEach(([name, value]) => {
        const reason = name.slice("borrowing.summary.demandReason.".length);
        const samples = summaryDemandReasons.get(reason) ?? [];
        samples.push(value);
        summaryDemandReasons.set(reason, samples);
      });
    borrowingContractComputationMs.push(
      summary.phasesMs["analyzeBorrowing.computeContracts"] ?? 0,
    );
    borrowingFactExtractionMs.push(
      summary.phasesMs["analyzeBorrowing.extractFacts"] ?? 0,
    );
    borrowingInferenceMs.push(
      summary.phasesMs["analyzeBorrowing.inferContracts"] ?? 0,
    );
    borrowingValidationMs.push(
      summary.phasesMs["analyzeBorrowing.validateContracts"] ?? 0,
    );
    borrowingBodySelectionMs.push(
      summary.phasesMs["analyzeBorrowing.selectBodies"] ?? 0,
    );
    borrowingLoanCheckingMs.push(
      summary.phasesMs["analyzeBorrowing.checkLoans"] ?? 0,
    );
  }
  if (!compiled) {
    throw new Error("benchmark did not compile a sample");
  }

  const host = await hostModule.createVoydHost({ wasm: compiled.wasm });
  for (let warmup = 0; warmup < 3; warmup += 1) {
    const result = await host.runPure<number>("main");
    if (result !== 1_100_340_000) {
      throw new Error(`unexpected benchmark warmup result ${result}`);
    }
  }
  const memory = host.instance.exports.memory;
  const beforeBytes =
    memory instanceof WebAssembly.Memory ? memory.buffer.byteLength : 0;
  const runtimeMs: number[] = [];
  for (let sample = 0; sample < runtimeSampleCount; sample += 1) {
    const startedAt = performance.now();
    const result = await host.runPure<number>("main");
    runtimeMs.push(performance.now() - startedAt);
    if (result !== 1_100_340_000) {
      throw new Error(`unexpected benchmark result ${result}`);
    }
  }
  const afterBytes =
    memory instanceof WebAssembly.Memory ? memory.buffer.byteLength : 0;
  const wasmText = compiled.wasmText ?? "";

  return {
    compileMs,
    compileMedianMs: median(compileMs),
    compilerTotalMs,
    compilerTotalMedianMs: median(compilerTotalMs),
    retainedContractCount,
    retainedContractCountMedian: median(retainedContractCount),
    retainedContractBytes,
    retainedContractMedianBytes: median(retainedContractBytes),
    factBlocks,
    factBlockMedian: median(factBlocks),
    factOperations,
    factOperationMedian: median(factOperations),
    totalBodyCallables,
    totalBodyCallableMedian: median(totalBodyCallables),
    checkedBodyCallables,
    checkedBodyCallableMedian: median(checkedBodyCallables),
    dependencyAssemblyAvailableModules,
    dependencyAssemblyAvailableModuleMedian: median(
      dependencyAssemblyAvailableModules,
    ),
    dependencyAssemblyDirectEdges,
    dependencyAssemblyDirectEdgeMedian: median(dependencyAssemblyDirectEdges),
    dependencyAssemblyImportTargets,
    dependencyAssemblyImportTargetMedian: median(
      dependencyAssemblyImportTargets,
    ),
    dependencyAssemblyEdgeCandidates,
    dependencyAssemblyEdgeCandidateMedian: median(
      dependencyAssemblyEdgeCandidates,
    ),
    dependencyAssemblyProjectedModules,
    dependencyAssemblyProjectedModuleMedian: median(
      dependencyAssemblyProjectedModules,
    ),
    dependencyProjectionCacheHits,
    dependencyProjectionCacheHitMedian: median(dependencyProjectionCacheHits),
    dependencyProjectionCacheMisses,
    dependencyProjectionCacheMissMedian: median(
      dependencyProjectionCacheMisses,
    ),
    summaryDemand: {
      totalCallables: {
        samples: totalSummaryCallables,
        median: median(totalSummaryCallables),
      },
      demandedCallables: {
        samples: demandedSummaryCallables,
        median: median(demandedSummaryCallables),
      },
      skippedTrivialCallables: {
        samples: skippedTrivialSummaryCallables,
        median: median(skippedTrivialSummaryCallables),
      },
      worklistEdges: {
        samples: summaryDemandWorklistEdges,
        median: median(summaryDemandWorklistEdges),
      },
      worklistIterations: {
        samples: summaryDemandWorklistIterations,
        median: median(summaryDemandWorklistIterations),
      },
      evaluations: {
        samples: summaryEvaluations,
        median: median(summaryEvaluations),
      },
      demandReasons: Object.fromEntries(
        Array.from(summaryDemandReasons, ([reason, samples]) => [
          reason,
          { samples, median: median(samples) },
        ]),
      ),
      contractComputationMs: {
        samples: borrowingContractComputationMs,
        median: median(borrowingContractComputationMs),
      },
      factExtractionMs: {
        samples: borrowingFactExtractionMs,
        median: median(borrowingFactExtractionMs),
      },
      inferenceMs: {
        samples: borrowingInferenceMs,
        median: median(borrowingInferenceMs),
      },
      validationMs: {
        samples: borrowingValidationMs,
        median: median(borrowingValidationMs),
      },
      bodySelectionMs: {
        samples: borrowingBodySelectionMs,
        median: median(borrowingBodySelectionMs),
      },
      loanCheckingMs: {
        samples: borrowingLoanCheckingMs,
        median: median(borrowingLoanCheckingMs),
      },
    },
    runtimeMs,
    runtimeMedianMs: median(runtimeMs),
    linearMemoryGrowthBytes: afterBytes - beforeBytes,
    generatedAllocationSites: count(
      wasmText,
      /\((?:array|struct)\.new(?:_fixed|_default)?\b/g,
    ),
    identityGuardComparisons: count(wasmText, /ref\.eq/g),
    wasmBytes: compiled.wasm.byteLength,
    wasmTextBytes: new TextEncoder().encode(wasmText).byteLength,
  };
};

const measureGuardOverhead = async (optimize: boolean) => {
  const result = await sdkModule.createSdk().compile({
    entryPath: guardedFixtureEntryPath,
    optimize,
    emitWasmText: true,
  });
  if (!result.success) {
    return {
      supported: false as const,
      diagnostics: result.diagnostics.map(
        ({ code, message }) =>
          `${code ?? "unknown"}: ${message ?? "unknown diagnostic"}`,
      ),
    };
  }

  const host = await hostModule.createVoydHost({ wasm: result.wasm });
  for (let warmup = 0; warmup < 3; warmup += 1) {
    const guarded = await host.runPure<number>("guard_success_benchmark");
    const staticallyDisjoint = await host.runPure<number>(
      "static_success_benchmark",
    );
    if (guarded !== 30_011 || staticallyDisjoint !== 30_011) {
      throw new Error(
        `unexpected guard benchmark warmup ${guarded}/${staticallyDisjoint}`,
      );
    }
  }

  const guardedRuntimeMs: number[] = [];
  const staticallyDisjointRuntimeMs: number[] = [];
  for (let sample = 0; sample < runtimeSampleCount; sample += 1) {
    const guardedStartedAt = performance.now();
    const guarded = await host.runPure<number>("guard_success_benchmark");
    guardedRuntimeMs.push(performance.now() - guardedStartedAt);

    const staticStartedAt = performance.now();
    const staticallyDisjoint = await host.runPure<number>(
      "static_success_benchmark",
    );
    staticallyDisjointRuntimeMs.push(performance.now() - staticStartedAt);
    if (guarded !== 30_011 || staticallyDisjoint !== 30_011) {
      throw new Error(
        `unexpected guard benchmark result ${guarded}/${staticallyDisjoint}`,
      );
    }
  }

  const guardedMedianMs = median(guardedRuntimeMs);
  const staticallyDisjointMedianMs = median(staticallyDisjointRuntimeMs);
  const deltaMedianMs = guardedMedianMs - staticallyDisjointMedianMs;
  const wasmText = result.wasmText ?? "";
  return {
    supported: true as const,
    guardedCallsPerSample: 10_000,
    guardedRuntimeMs,
    guardedMedianMs,
    staticallyDisjointRuntimeMs,
    staticallyDisjointMedianMs,
    deltaMedianMs,
    overheadNanosecondsPerGuardedCall: (deltaMedianMs * 1_000_000) / 10_000,
    identityComparisonsInModule: count(wasmText, /ref\.eq/g),
    wasmBytes: result.wasm.byteLength,
    wasmTextBytes: new TextEncoder().encode(wasmText).byteLength,
  };
};

const none = await measureMode(false);
const release = await measureMode(true);
const guardOverhead = {
  none: await measureGuardOverhead(false),
  release: await measureGuardOverhead(true),
};
console.error = originalConsoleError;

const cpu = cpus();
console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      label,
      repository,
      fixture: "scalar-aggregate-representative.voyd",
      methodology: {
        compileSamples: sampleCount,
        runtimeWarmups: 3,
        runtimeSamples: runtimeSampleCount,
        freshSdkPerCompile: true,
        contractBytes:
          "borrowing.contract.retainedBytes is the compact caller-visible contract footprint retained in the public semantic table",
        factAndBodyDemand:
          "fact blocks/operations measure the single callable-local extraction; total/checked body callables measure conservative fast-path admission",
        summaryDemand:
          "total/demanded/skipped callable counters cover compact contract inference; worklist counters cover local call, callable-reference, and trait-dispatch propagation in the single SCC solve",
        dependencyProjection:
          "assembly counters contrast analyzed-prefix modules with unique graph/import edge candidates and projected modules; cache hits/misses count immutable compact-contract projections",
        allocation:
          "static generated Wasm GC allocation instruction sites plus repeated-run linear-memory growth",
        guardOverhead:
          "paired runtime medians for 10,000 dynamically guarded and statically disjoint calls in one module; the baseline may report unsupported when the fallback did not exist",
      },
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpu: cpu[0]?.model ?? "unknown",
        logicalCpus: cpu.length,
        totalMemoryBytes: totalmem(),
      },
      modes: { none, release },
      guardOverhead,
    },
    null,
    2,
  ),
);
