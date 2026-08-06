import path from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  createSdk,
  type CompileResult,
  type VoydRuntimeError,
} from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";

const runPerf = process.env.VOYD_RUN_PERF_SMOKE === "1";
const perfDescribe = runPerf ? describe : describe.skip;
const fixture = (name: string): string =>
  path.join(import.meta.dirname, "..", "fixtures", name);

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

const allocationOps = (wasmText: string): number =>
  count(wasmText, /\((?:array|struct)\.new(?:_fixed|_default)?\b/g);

const expectPanicMessage = async (
  run: Promise<unknown>,
  message: RegExp,
): Promise<void> => {
  try {
    await run;
    throw new Error("expected runtime panic");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const runtimeError = error as VoydRuntimeError;
    expect(runtimeError.voyd.panic).toMatchObject({
      status: "available",
      message: expect.stringMatching(message),
    });
  }
};

perfDescribe("performance: memory and mutation safety", () => {
  it(
    "keeps ordinary values and iterators free of borrow bookkeeping",
    { timeout: 300_000 },
    async () => {
      const entryPath = fixture("memory-mutation-safety-ordinary.voyd");
      const startedAt = performance.now();
      const [baseline, optimized] = await Promise.all(
        [false, true].map(async (optimize) =>
          expectCompileSuccess(
            await createSdk().compile({
              entryPath,
              optimize,
              emitWasmText: true,
            }),
          ),
        ),
      );
      const baselineText = baseline.wasmText ?? "";
      const optimizedText = optimized.wasmText ?? "";
      const [baselineHost, optimizedHost] = await Promise.all([
        createVoydHost({ wasm: baseline.wasm }),
        createVoydHost({ wasm: optimized.wasm }),
      ]);

      await expect(
        baselineHost.runPure<number>("ordinary_iterator_benchmark"),
      ).resolves.toBe(272_000);
      await expect(
        optimizedHost.runPure<number>("ordinary_iterator_benchmark"),
      ).resolves.toBe(272_000);
      await expect(
        baselineHost.runPure<number>("physical_materialization"),
      ).resolves.toBe(1_140);
      await expect(
        optimizedHost.runPure<number>("physical_materialization"),
      ).resolves.toBe(1_140);

      expect(baselineText).not.toContain("ref.eq");
      expect(optimizedText).not.toContain("ref.eq");
      expect(baselineText).not.toContain("__voyd_panic");
      expect(optimizedText).not.toContain("__voyd_panic");
      expect(allocationOps(optimizedText)).toBeLessThanOrEqual(
        allocationOps(baselineText),
      );

      const memory = optimizedHost.instance.exports.memory;
      const beforeBytes =
        memory instanceof WebAssembly.Memory
          ? memory.buffer.byteLength
          : undefined;
      for (let iteration = 0; iteration < 5; iteration += 1) {
        await expect(
          optimizedHost.runPure<number>("ordinary_iterator_benchmark"),
        ).resolves.toBe(272_000);
      }
      const afterBytes =
        memory instanceof WebAssembly.Memory
          ? memory.buffer.byteLength
          : undefined;
      expect(afterBytes).toBe(beforeBytes);

      console.info(
        `[memory-safety:ordinary] compilePairMs=${(performance.now() - startedAt).toFixed(2)} baselineWasmBytes=${baseline.wasm.byteLength} optimizedWasmBytes=${optimized.wasm.byteLength} baselineAllocationSites=${allocationOps(baselineText)} optimizedAllocationSites=${allocationOps(optimizedText)} linearMemoryGrowthBytes=${(afterBytes ?? 0) - (beforeBytes ?? 0)}`,
      );
    },
  );

  it(
    "keeps call-scoped identity guards correct in every build mode",
    { timeout: 300_000 },
    async () => {
      const guardedPath = fixture("memory-mutation-safety-guarded.voyd");
      const staticPath = fixture("memory-mutation-safety-static.voyd");
      const [
        guardedBaseline,
        guardedOptimized,
        staticBaseline,
        staticOptimized,
      ] = await Promise.all([
        createSdk().compile({
          entryPath: guardedPath,
          optimize: false,
          emitWasmText: true,
        }),
        createSdk().compile({
          entryPath: guardedPath,
          optimize: true,
          emitWasmText: true,
        }),
        createSdk().compile({
          entryPath: staticPath,
          optimize: false,
          emitWasmText: true,
        }),
        createSdk().compile({
          entryPath: staticPath,
          optimize: true,
          emitWasmText: true,
        }),
      ]).then((results) => results.map(expectCompileSuccess));
      const guardedBaselineText = guardedBaseline.wasmText ?? "";
      const guardedOptimizedText = guardedOptimized.wasmText ?? "";
      const staticBaselineText = staticBaseline.wasmText ?? "";
      const staticOptimizedText = staticOptimized.wasmText ?? "";

      expect(guardedBaselineText).toContain("ref.eq");
      expect(guardedOptimizedText).toContain("ref.eq");
      expect(guardedBaselineText).not.toMatch(
        /reader_count|loan_state|identity_guard_state/,
      );
      expect(guardedOptimizedText).not.toMatch(
        /reader_count|loan_state|identity_guard_state/,
      );

      const [
        baselineHost,
        optimizedHost,
        staticBaselineHost,
        staticOptimizedHost,
      ] = await Promise.all([
        createVoydHost({ wasm: guardedBaseline.wasm }),
        createVoydHost({ wasm: guardedOptimized.wasm }),
        createVoydHost({ wasm: staticBaseline.wasm }),
        createVoydHost({ wasm: staticOptimized.wasm }),
      ]);
      await expect(baselineHost.runPure<number>("guard_success")).resolves.toBe(
        14,
      );
      await expect(
        optimizedHost.runPure<number>("guard_success"),
      ).resolves.toBe(14);
      await expect(
        baselineHost.runPure<number>("guard_success_benchmark"),
      ).resolves.toBe(30_011);
      await expect(
        baselineHost.runPure<number>("static_success_benchmark"),
      ).resolves.toBe(30_011);
      await expect(
        optimizedHost.runPure<number>("guard_success_benchmark"),
      ).resolves.toBe(30_011);
      await expect(
        optimizedHost.runPure<number>("static_success_benchmark"),
      ).resolves.toBe(30_011);
      await expectPanicMessage(
        baselineHost.runPure<number>("guard_conflict"),
        /Runtime exclusivity conflict.*argument 1 place values.*argument 2 place values/,
      );
      await expectPanicMessage(
        optimizedHost.runPure<number>("guard_conflict"),
        /Runtime exclusivity conflict.*argument 1 place values.*argument 2 place values/,
      );
      await expect(
        staticBaselineHost.runPure<number>("statically_disjoint"),
      ).resolves.toBe(14);
      await expect(
        staticOptimizedHost.runPure<number>("statically_disjoint"),
      ).resolves.toBe(14);

      console.info(
        `[memory-safety:guards] baselineGuardComparisons=${count(guardedBaselineText, /ref\\.eq/g)} optimizedGuardComparisons=${count(guardedOptimizedText, /ref\\.eq/g)} staticBaselineComparisons=${count(staticBaselineText, /ref\\.eq/g)} staticOptimizedComparisons=${count(staticOptimizedText, /ref\\.eq/g)}`,
      );
    },
  );
});
