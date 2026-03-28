import path from "node:path";
import { performance } from "node:perf_hooks";
import { beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd/sdk";
import { createVoydHost } from "@voyd/sdk/js-host";

const fixtureEntryPath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "vtrace-compute-benchmark.voyd"
);

const runPerf = process.env.VOYD_RUN_PERF_SMOKE === "1";
const perfIt = runPerf ? it : it.skip;
const mainIt = runPerf ? it : it.skip;
const perfIterations = Number.parseInt(process.env.VOYD_PERF_ITERATIONS ?? "3", 10);
const mainChecksum = 3_825_271;
const benchmarkChecksum = 57_372_071;
const debugEffectRandPlain = 0.000005046497183913701;
const debugEffectRandRange = 0.0000025232485919568504;
const debugEffectRandVec3Sum = 0.4670804432993078;
const debugEmptyWorldChecksum = 4_957_200;

const expectCompileSuccess = (
  result: CompileResult
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  expect(result.success).toBe(true);
  return result;
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

describe("smoke: vtrace compute-only benchmark", () => {
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(
      await sdk.compile({ entryPath: fixtureEntryPath, optimize: true }),
    );
  });

  mainIt("renders the compute-only checksum deterministically without output effects", async () => {
    const result = await compiled.run<number>({ entryName: "main" });
    expect(result).toBe(mainChecksum);
  });

  it("keeps the plain effect RNG probe deterministic", async () => {
    const result = await compiled.run<number>({ entryName: "debug_effect_rand_plain" });
    expect(result).toBe(debugEffectRandPlain);
  });

  it("keeps the ranged effect RNG probe deterministic", async () => {
    const result = await compiled.run<number>({ entryName: "debug_effect_rand_range" });
    expect(result).toBe(debugEffectRandRange);
  });

  it("keeps the Vec3 ranged effect RNG probe deterministic", async () => {
    const result = await compiled.run<number>({ entryName: "debug_effect_rand_vec3_sum" });
    expect(result).toBe(debugEffectRandVec3Sum);
  });

  it("keeps the empty-world checksum deterministic", async () => {
    const result = await compiled.run<number>({ entryName: "debug_empty_world_checksum" });
    expect(result).toBe(debugEmptyWorldChecksum);
  });

  perfIt(
    "profiles the heavier compute-only entrypoint without stdout/stderr noise",
    { timeout: 300_000 },
    async () => {
      const host = await createVoydHost({ wasm: compiled.wasm });

      await expect(host.run<number>("benchmark")).resolves.toBe(benchmarkChecksum);

      const durationsMs: number[] = [];
      for (let iteration = 0; iteration < perfIterations; iteration += 1) {
        const startedAt = performance.now();
        await expect(host.run<number>("benchmark")).resolves.toBe(benchmarkChecksum);
        durationsMs.push(performance.now() - startedAt);
      }

      console.info(
        `[vtrace-compute-benchmark] iterations=${perfIterations} medianMs=${median(durationsMs).toFixed(2)} samples=${durationsMs
          .map((duration) => duration.toFixed(2))
          .join(",")}`
      );
    }
  );
});
