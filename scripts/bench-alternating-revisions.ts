import { spawnSync } from "node:child_process";
import path from "node:path";

type Sample = {
  durationMs: number;
  peakHeapUsedBytes: number;
  peakRssBytes: number;
  phasesMs: Record<string, number>;
  counters: Record<string, number>;
  wasmBytes: number;
  wasmSha256: string;
  processMaxRssBytes: number;
  processMaxRssGrowthBytes: number;
};

type WorkerResult = { sample: Sample };

const valuesAfter = (name: string): string[] =>
  process.argv.flatMap((value, index) =>
    value === name && process.argv[index + 1] ? [process.argv[index + 1]!] : [],
  );
const valueAfter = (name: string): string | undefined => valuesAfter(name)[0];
const repositories = valuesAfter("--repo").map((entry) => {
  const separator = entry.indexOf("=");
  if (separator <= 0) {
    throw new Error("--repo must use label=/absolute/path");
  }
  return {
    label: entry.slice(0, separator),
    repository: path.resolve(entry.slice(separator + 1)),
  };
});
if (repositories.length < 2) {
  throw new Error("provide at least two --repo label=/absolute/path entries");
}
const sampleCount = Number.parseInt(valueAfter("--samples") ?? "7", 10);
if (!Number.isSafeInteger(sampleCount) || sampleCount < 3) {
  throw new Error("--samples must be an integer of at least 3");
}
const scenarioName = valueAfter("--scenario") ?? "std-math-transcendentals";
const compactOutput = process.argv.includes("--compact");
const modes = (valueAfter("--modes") ?? "unoptimized,release").split(",");
if (
  modes.some(
    (mode) =>
      mode !== "unoptimized" && mode !== "balanced" && mode !== "release",
  )
) {
  throw new Error(`unsupported modes ${modes.join(",")}`);
}

const results = new Map<string, Map<string, Sample[]>>(
  repositories.map(({ label }) => [
    label,
    new Map(modes.map((mode) => [mode, []])),
  ]),
);
const workerConfig = (mode: string): string =>
  Buffer.from(
    JSON.stringify({
      scenarioName,
      mode,
      runtimeSamples: 0,
      runtimeSampleMinMs: 0,
      collectArtifactDetails: false,
    }),
  ).toString("base64url");

for (const mode of modes) {
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const ordered =
      sample % 2 === 0 ? repositories : [...repositories].reverse();
    for (const { label, repository } of ordered) {
      const child = spawnSync(
        process.execPath,
        [
          "--conditions=development",
          "--import",
          "tsx",
          path.join(repository, "scripts/bench-optimizer.ts"),
          "--worker-config",
          workerConfig(mode),
        ],
        {
          cwd: repository,
          encoding: "utf8",
          env: {
            ...process.env,
            VOYD_COMPILER_PERF: "1",
            VOYD_DISABLE_PRECOMPILED_STD_SNAPSHOT: "1",
          },
          maxBuffer: 10 * 1024 * 1024,
        },
      );
      if (child.status !== 0) {
        throw new Error(
          `${label}/${mode} benchmark failed:\n${child.stderr || child.stdout}`,
        );
      }
      const result = JSON.parse(child.stdout) as WorkerResult;
      results.get(label)!.get(mode)!.push(result.sample);
    }
  }
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
};
const medianRecord = (
  records: readonly Readonly<Record<string, number>>[],
): Record<string, number> =>
  Object.fromEntries(
    Array.from(new Set(records.flatMap((record) => Object.keys(record))))
      .sort()
      .map((key) => [key, median(records.map((record) => record[key] ?? 0))]),
  );
const summarize = (samples: readonly Sample[]) => {
  const hashes = new Set(samples.map((sample) => sample.wasmSha256));
  const sizes = new Set(samples.map((sample) => sample.wasmBytes));
  if (hashes.size !== 1 || sizes.size !== 1) {
    throw new Error("a revision emitted nondeterministic Wasm");
  }
  const summary = {
    compileMs: samples.map((sample) => sample.durationMs),
    compileMedianMs: median(samples.map((sample) => sample.durationMs)),
    peakHeapUsedBytes: samples.map((sample) => sample.peakHeapUsedBytes),
    peakHeapUsedMedianBytes: median(
      samples.map((sample) => sample.peakHeapUsedBytes),
    ),
    processMaxRssBytes: samples.map((sample) => sample.processMaxRssBytes),
    processMaxRssMedianBytes: median(
      samples.map((sample) => sample.processMaxRssBytes),
    ),
    processMaxRssGrowthBytes: samples.map(
      (sample) => sample.processMaxRssGrowthBytes,
    ),
    processMaxRssGrowthMedianBytes: median(
      samples.map((sample) => sample.processMaxRssGrowthBytes),
    ),
    wasmBytes: samples[0]!.wasmBytes,
    wasmSha256: samples[0]!.wasmSha256,
    phaseMediansMs: medianRecord(samples.map((sample) => sample.phasesMs)),
    counterMedians: medianRecord(samples.map((sample) => sample.counters)),
  };
  if (!compactOutput) return summary;
  const { phaseMediansMs, counterMedians, ...compact } = summary;
  return {
    ...compact,
    borrowingPhaseMediansMs: Object.fromEntries(
      Object.entries(phaseMediansMs).filter(([name]) =>
        name.startsWith("analyzeBorrowing"),
      ),
    ),
    borrowingCounterMedians: Object.fromEntries(
      Object.entries(counterMedians).filter(([name]) =>
        name.startsWith("borrowing."),
      ),
    ),
  };
};

process.stdout.write(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      methodology: {
        scenarioName,
        samplesPerRevisionAndMode: sampleCount,
        freshNodeProcessPerSample: true,
        alternatingRevisionOrder: true,
        precompiledStdSnapshotDisabled: true,
      },
      results: Object.fromEntries(
        Array.from(results, ([label, byMode]) => [
          label,
          Object.fromEntries(
            Array.from(byMode, ([mode, samples]) => [mode, summarize(samples)]),
          ),
        ]),
      ),
    },
    null,
    2,
  )}\n`,
);
