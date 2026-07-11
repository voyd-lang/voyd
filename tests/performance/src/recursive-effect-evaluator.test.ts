import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";

const runPerf = process.env.VOYD_RUN_PERF_SMOKE === "1";
const perfDescribe = runPerf ? describe : describe.skip;
const fixtureEntryPath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "recursive-effect-evaluator.voyd",
);

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

const median = (values: number[]): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
};

const measure = async ({
  host,
  entryName,
}: {
  host: Awaited<ReturnType<typeof createVoydHost>>;
  entryName: string;
}): Promise<number> => {
  const durations: number[] = [];
  for (let iteration = 0; iteration < 7; iteration += 1) {
    const startedAt = performance.now();
    await host.run<number>(entryName);
    durations.push(performance.now() - startedAt);
  }
  return median(durations);
};

perfDescribe("performance: recursive static-effect evaluator", () => {
  it("runs an evaluator-shaped mutually recursive graph at production depth", async () => {
    const compiled = expectCompileSuccess(
      await createSdk().compile({ entryPath: fixtureEntryPath, optimize: true }),
    );
    const host = await createVoydHost({ wasm: compiled.wasm });

    await expect(host.run<number>("main")).resolves.toBe(30001);
    await expect(host.run<number>("specialized_benchmark")).resolves.toBe(
      4_499_500,
    );
    await expect(host.run<number>("residual_benchmark")).resolves.toBe(
      4_499_500,
    );
    const specializedMs = await measure({
      host,
      entryName: "specialized_benchmark",
    });
    const residualMs = await measure({ host, entryName: "residual_benchmark" });
    expect(specializedMs).toBeLessThan(residualMs * 0.5);
    const startedAt = performance.now();
    await expect(host.run<number>("benchmark")).resolves.toBe(750001);
    console.info(
      `[recursive-effect-evaluator] wasmBytes=${compiled.wasm.byteLength} deepRuntimeMs=${(
        performance.now() - startedAt
      ).toFixed(2)} specializedMedianMs=${specializedMs.toFixed(3)} residualMedianMs=${residualMs.toFixed(3)}`,
    );
  });
});
