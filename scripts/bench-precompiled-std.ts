import { cpus, totalmem } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

type Mode = "snapshot" | "source";
type Sample = {
  compileMs: number;
  wasmBytes: number;
  wasmSha256: string;
  snapshotHits: number;
  snapshotFallbacks: number;
  snapshotFallbackReasons: Readonly<Record<string, number>>;
  snapshotLoadMs?: number;
};

const sampleCount = Number.parseInt(process.argv[2] ?? "7", 10);
if (!Number.isSafeInteger(sampleCount) || sampleCount < 3) {
  throw new Error("sample count must be an integer of at least 3");
}

const repoRoot = process.cwd();
const fixture = path.join(
  repoRoot,
  "tests/performance/fixtures/scalar-aggregate-representative.voyd",
);
const results = {
  none: { snapshot: [] as Sample[], source: [] as Sample[] },
  release: { snapshot: [] as Sample[], source: [] as Sample[] },
};

for (const [optimization, optimize] of [
  ["none", false],
  ["release", true],
] as const) {
  for (let index = 0; index < sampleCount; index += 1) {
    const order: readonly Mode[] =
      index % 2 === 0 ? ["source", "snapshot"] : ["snapshot", "source"];
    order.forEach((mode) => {
      results[optimization][mode].push(
        runFreshProcess({ fixture, mode, optimize }),
      );
    });
  }
}

Object.values(results).forEach(({ snapshot, source }) => {
  const hashes = new Set(
    [...snapshot, ...source].map((sample) => sample.wasmSha256),
  );
  if (hashes.size !== 1) {
    throw new Error("snapshot and source analysis emitted different Wasm");
  }
});

const summarize = (samples: readonly Sample[]) => ({
  compileMs: samples.map((sample) => sample.compileMs),
  medianCompileMs: median(samples.map((sample) => sample.compileMs)),
  wasmBytes: samples[0]?.wasmBytes,
  wasmSha256: samples[0]?.wasmSha256,
  snapshotLoadMs: samples.flatMap((sample) =>
    sample.snapshotLoadMs === undefined ? [] : [sample.snapshotLoadMs],
  ),
  medianSnapshotLoadMs: median(
    samples.flatMap((sample) =>
      sample.snapshotLoadMs === undefined ? [] : [sample.snapshotLoadMs],
    ),
  ),
});
const summarized = {
  none: {
    snapshot: summarize(results.none.snapshot),
    source: summarize(results.none.source),
  },
  release: {
    snapshot: summarize(results.release.snapshot),
    source: summarize(results.release.source),
  },
};

process.stdout.write(
  `${JSON.stringify(
    {
      methodology: {
        samplesPerMode: sampleCount,
        freshNodeProcessPerSample: true,
        alternatingPairOrder: true,
      },
      environment: {
        platform: process.platform,
        arch: process.arch,
        node: process.version,
        cpu: cpus()[0]?.model ?? "unknown",
        logicalCpus: cpus().length,
        totalMemoryBytes: totalmem(),
      },
      modes: summarized,
    },
    null,
    2,
  )}\n`,
);

function runFreshProcess({
  fixture,
  mode,
  optimize,
}: {
  fixture: string;
  mode: Mode;
  optimize: boolean;
}): Sample {
  const script = `
    import { performance } from "node:perf_hooks";
    import { createHash } from "node:crypto";
    import { createSdk, snapshotPrecompiledStdLoadStats } from "./packages/sdk/src/node.ts";
    const startedAt = performance.now();
    const result = await createSdk().compile({
      entryPath: ${JSON.stringify(fixture)},
      optimize: ${JSON.stringify(optimize)}
    });
    if (!result.success) {
      throw new Error(result.diagnostics.map(({ code, message }) => \`\${code}: \${message}\`).join("\\n"));
    }
    const stats = snapshotPrecompiledStdLoadStats();
    process.stdout.write(JSON.stringify({
      compileMs: performance.now() - startedAt,
      wasmBytes: result.wasm.byteLength,
      wasmSha256: createHash("sha256").update(result.wasm).digest("hex"),
      snapshotHits: stats.hits,
      snapshotFallbacks: stats.fallbacks,
      snapshotFallbackReasons: stats.fallbackReasons,
      snapshotLoadMs: stats.lastLoadMs
    }));
  `;
  const env = { ...process.env };
  delete env.VOYD_COMPILER_PERF;
  if (mode === "source") {
    env.VOYD_DISABLE_PRECOMPILED_STD_SNAPSHOT = "1";
  } else {
    delete env.VOYD_DISABLE_PRECOMPILED_STD_SNAPSHOT;
  }
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--conditions=development",
      "--import",
      "tsx",
      "--eval",
      script,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      maxBuffer: 1024 * 1024,
    },
  );
  if (child.status !== 0) {
    throw new Error(child.stderr || child.stdout || "benchmark child failed");
  }
  const sample = JSON.parse(child.stdout) as Sample;
  if (
    (mode === "snapshot" &&
      (sample.snapshotHits !== 1 || sample.snapshotFallbacks !== 0)) ||
    (mode === "source" &&
      (sample.snapshotHits !== 0 || sample.snapshotFallbacks !== 1))
  ) {
    throw new Error(`unexpected ${mode} loader stats: ${child.stdout}`);
  }
  return sample;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle];
}
