import { gzipSync } from "node:zlib";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";

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

const compileSamples = positiveInt("--compile-samples", 5);
const runtimeSamples = positiveInt("--runtime-samples", 21);
const label = valueAfter("--label") ?? "local";
const entryPath = resolve(
  "tests/performance/fixtures/array-for-fast-path.voyd",
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
console.log(
  JSON.stringify(
    {
      benchmark: "intrinsic-array-for-fast-path",
      label,
      methodology: {
        compileSamples,
        runtimeSamples,
        optimize: true,
        compilerCache: "none",
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
    null,
    2,
  ),
);
