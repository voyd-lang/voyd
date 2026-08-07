import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { cpus } from "node:os";
import type { CompileResult } from "@voyd-lang/sdk";

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
      result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"),
    );
  }
  return result;
};

const count = (source: string, pattern: RegExp): number =>
  Array.from(source.matchAll(pattern)).length;

const compileSamples = positiveInt("--compile-samples", 7);
const runtimeSamples = positiveInt("--runtime-samples", 31);
const label = valueAfter("--label") ?? "local";
const sdkRoot = valueAfter("--sdk-root");
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
  "tests/performance/fixtures/mutable-result-specialization.voyd",
);
const sdk = createSdk({ compilerCache: "none" });
const compileDurationsMs: number[] = [];
let compiled: Extract<CompileResult, { success: true }> | undefined;

for (let sample = 0; sample < compileSamples; sample += 1) {
  const startedAt = performance.now();
  compiled = expectCompileSuccess(
    await sdk.compile({ entryPath, optimize: true, emitWasmText: true }),
  );
  compileDurationsMs.push(performance.now() - startedAt);
}

if (!compiled) {
  throw new Error("benchmark did not compile a program");
}

const host = await createVoydHost({ wasm: compiled.wasm });
const entries = [
  "direct_result_workload",
  "discarded_result_workload",
  "manual_control",
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
  }
  runtimes[entry] = { medianMs: median(samplesMs), samplesMs };
}

if (
  checksums.get("direct_result_workload") !== checksums.get("manual_control")
) {
  throw new Error("specialized workloads and manual control disagree");
}

const wasmText = compiled.wasmText ?? "";
console.log(
  JSON.stringify(
    {
      benchmark: "mutable-result-specialization",
      label,
      methodology: {
        compileSamples,
        runtimeSamples,
        optimize: true,
        compilerCache: "none",
        sdkRoot: sdkRoot ?? "current checkout",
        runtimeHost: "one warmed host; one untimed warmup per entry",
      },
      compile: {
        medianMs: median(compileDurationsMs),
        samplesMs: compileDurationsMs,
      },
      artifact: {
        wasmBytes: compiled.wasm.byteLength,
        gzipBytes: gzipSync(compiled.wasm).byteLength,
        callRefSites: count(wasmText, /\bcall_ref\b/g),
        directCallSites: count(wasmText, /\(call \$/g),
        allocationSites: count(
          wasmText,
          /\((?:array|struct)\.new(?:_fixed|_default)?\b/g,
        ),
        structGetSites: count(wasmText, /\(struct\.get\b/g),
        structSetSites: count(wasmText, /\(struct\.set\b/g),
      },
      checksums: Object.fromEntries(checksums),
      runtimes,
      environment: {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpu: cpus()[0]?.model ?? "unknown",
      },
    },
    null,
    2,
  ),
);
