import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { CompileResult } from "@voyd-lang/sdk";
import {
  captureCompilerPerf,
  createProcessMemoryTracker,
  emitBenchmarkReport,
} from "./benchmark-report.js";

const valueAfter = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const positiveInt = (name: string, fallback: number): number => {
  const raw = valueAfter(name);
  const value = raw === undefined ? fallback : Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
};

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
};

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(
      ("diagnostics" in result ? result.diagnostics : [])
        .map((diagnostic) => diagnostic.message)
        .join("\n"),
    );
  }
  return result;
};

const count = (source: string, pattern: RegExp): number =>
  Array.from(source.matchAll(pattern)).length;

const medianRecord = (
  records: readonly Readonly<Record<string, number>>[],
): Record<string, number> => {
  const keys = new Set(records.flatMap((record) => Object.keys(record)));
  return Object.fromEntries(
    Array.from(keys)
      .sort()
      .map((key) => [key, median(records.map((record) => record[key] ?? 0))]),
  );
};

const compileSamples = positiveInt("--compile-samples", 5);
const runtimeSamples = positiveInt("--runtime-samples", 21);
const label = valueAfter("--label") ?? "local";
const sdkRoot = valueAfter("--sdk-root");
const outputPath = valueAfter("--output");
const memoryTracker = createProcessMemoryTracker();
process.env.VOYD_COMPILER_PERF = "1";
const sdkModule = sdkRoot
  ? pathToFileURL(resolve(sdkRoot, "packages/sdk/src/index.ts")).href
  : "@voyd-lang/sdk";
const sdkHostModule = sdkRoot
  ? pathToFileURL(resolve(sdkRoot, "packages/sdk/src/js-host.ts")).href
  : "@voyd-lang/sdk/js-host";
const { createSdk } = (await import(
  sdkModule
)) as typeof import("@voyd-lang/sdk");
const { createVoydHost } = (await import(
  sdkHostModule
)) as typeof import("@voyd-lang/sdk/js-host");
const entryPath = resolve(
  "tests/performance/fixtures/array-for-fast-path.voyd",
);
const sdk = createSdk({ compilerCache: "none" });
const compileDurationsMs: number[] = [];
const compilerPerfSamples: Array<{
  phasesMs: Record<string, number>;
  counters: Record<string, number>;
}> = [];
let compiled: Extract<CompileResult, { success: true }> | undefined;

for (let sample = 0; sample < compileSamples; sample += 1) {
  const startedAt = performance.now();
  const captured = await captureCompilerPerf(() =>
    sdk.compile({ entryPath, optimize: true, emitWasmText: true }),
  );
  compiled = expectCompileSuccess(captured.value);
  compileDurationsMs.push(performance.now() - startedAt);
  memoryTracker.sample();
  const summary = captured.summaries.at(-1);
  compilerPerfSamples.push({
    phasesMs: summary?.phasesMs ?? {},
    counters: summary?.counters ?? {},
  });
}

if (!compiled) {
  throw new Error("benchmark did not compile a program");
}

const host = await createVoydHost({ wasm: compiled.wasm });
const entries = [
  "light_for_benchmark",
  "light_indexed_control",
  "render_for_benchmark",
  "render_indexed_control",
] as const;
const checksums = new Map<string, number>();
const runtimes: Record<string, { medianMs: number; samplesMs: number[] }> = {};

for (const entry of entries) {
  const checksum = await host.runPure<number>(entry);
  checksums.set(entry, checksum);
  const samplesMs: number[] = [];
  for (let sample = 0; sample < runtimeSamples; sample += 1) {
    const startedAt = performance.now();
    const value = await host.runPure<number>(entry);
    if (value !== checksum) {
      throw new Error(`${entry} returned a non-deterministic checksum`);
    }
    samplesMs.push(performance.now() - startedAt);
    memoryTracker.sample();
  }
  runtimes[entry] = { medianMs: median(samplesMs), samplesMs };
}

if (
  checksums.get("light_for_benchmark") !==
    checksums.get("light_indexed_control") ||
  checksums.get("render_for_benchmark") !==
    checksums.get("render_indexed_control")
) {
  throw new Error("for-loop and indexed controls produced different checksums");
}

const wasmText = compiled.wasmText ?? "";
emitBenchmarkReport({
  report: {
    schemaVersion: 2,
    benchmark: "intrinsic-array-for-fast-path",
    label,
    methodology: {
      compileSamples,
      runtimeSamples,
      optimize: true,
      compilerCache: "none",
      sdkRoot: sdkRoot ?? "current checkout",
      runtimeHost: "one warmed host; one untimed warmup per entry",
      compilerPerf: "VOYD_COMPILER_PERF=1; raw summary retained per compile",
      rawSamples:
        "compile, runtime, compiler phase/counter, and peak-process memory samples are retained",
    },
    compile: {
      medianMs: median(compileDurationsMs),
      samplesMs: compileDurationsMs,
      perfSamples: compilerPerfSamples,
      phaseMediansMs: medianRecord(
        compilerPerfSamples.map((sample) => sample.phasesMs),
      ),
      counterMedians: medianRecord(
        compilerPerfSamples.map((sample) => sample.counters),
      ),
    },
    processMemory: memoryTracker.finish(),
    artifact: {
      wasmBytes: compiled.wasm.byteLength,
      gzipBytes: gzipSync(compiled.wasm).byteLength,
      callRefSites: count(wasmText, /\bcall_ref\b/g),
      allocationSites: count(
        wasmText,
        /\((?:array|struct)\.new(?:_fixed|_default)?\b/g,
      ),
    },
    checksums: Object.fromEntries(checksums),
    runtimes,
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
  },
  outputPath,
});
