import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPILER_PERF_ZERO_PRESENCE_COUNTERS } from "@voyd-lang/compiler/perf-counter-schema.js";

const SOURCE = `#!no_prelude
fn answer() -> i32
  42

pub fn main() -> i32
  answer()
`;

describe("SDK compiler perf instrumentation", () => {
  afterEach(() => {
    delete process.env.VOYD_COMPILER_PERF;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("emits a compiler perf summary from the SDK compile path", async () => {
    process.env.VOYD_COMPILER_PERF = "1";
    vi.resetModules();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { createSdk } = await import("@voyd-lang/sdk");

    const result = await createSdk().compile({
      source: SOURCE,
      optimize: true,
      emitWasmText: true,
    });

    expect(result.success).toBe(true);
    expect(result.success ? result.wasmText : undefined).toBeDefined();
    const perfLine = errorSpy.mock.calls
      .map(([message]) => String(message))
      .find((message) => message.startsWith("[voyd:compiler:perf] "));
    expect(perfLine).toBeDefined();
    const summary = JSON.parse(
      perfLine!.slice("[voyd:compiler:perf] ".length),
    ) as {
      schemaVersion: number;
      success: boolean;
      phasesMs: Record<string, number>;
      counters: Record<string, number>;
    };
    expect(summary.schemaVersion).toBe(1);
    expect(summary.success).toBe(true);
    expect(summary.phasesMs.loadModuleGraph).toBeGreaterThanOrEqual(0);
    expect(summary.phasesMs.analyzeModules).toBeGreaterThanOrEqual(0);
    expect(
      summary.phasesMs["analyzeBorrowing.ordinaryMutation"],
    ).toBeGreaterThanOrEqual(0);
    expect(
      summary.phasesMs["analyzeBorrowing.explicitBorrow"],
    ).toBeGreaterThanOrEqual(0);
    expect(
      summary.phasesMs["analyzeBorrowing.finiteLocal"],
    ).toBeGreaterThanOrEqual(0);
    expect(summary.phasesMs.optimizeProgram).toBeGreaterThanOrEqual(0);
    expect(summary.phasesMs.codegen).toBeGreaterThanOrEqual(0);
    expect(summary.phasesMs["binaryen.optimize"]).toBeGreaterThanOrEqual(0);
    expect(summary.phasesMs["sdk.finalizeCompile"]).toBeGreaterThanOrEqual(0);
    expect(summary.phasesMs.total).toBeGreaterThanOrEqual(0);
    expect(
      summary.counters[
        "optimize.pass.0.pure-compile-time-evaluation.folded_calls"
      ],
    ).toBeGreaterThan(0);
    expect(
      summary.counters[
        "optimize.pass.4.whole-program-specialization-pruning.ms"
      ],
    ).toBeGreaterThanOrEqual(0);
    // The SDK compiles the selected std package graph as well as SOURCE. That
    // graph intentionally contains Borrow-aware String helpers, so this
    // boundary asserts schema presence while compiler-local/benchmark tests
    // own the zero-fact guarantee for an isolated ordinary module.
    expect(
      summary.counters["borrowing.explicitBorrowFacts"],
    ).toBeGreaterThanOrEqual(0);
    expect(summary.counters["borrowing.ordinary.callables"]).toBeGreaterThan(0);
    expect(summary.counters["borrowing.ordinary.projectionFamilies"]).toBe(0);
    expect(summary.counters["borrowing.ordinary.widenings"]).toBe(0);
    expect(
      summary.counters["optimize.pass.stable-field-load-forwarding.candidates"],
    ).toBe(0);
    expect(new Set(COMPILER_PERF_ZERO_PRESENCE_COUNTERS).size).toBe(
      COMPILER_PERF_ZERO_PRESENCE_COUNTERS.length,
    );
    COMPILER_PERF_ZERO_PRESENCE_COUNTERS.forEach((counter) => {
      expect(
        Object.hasOwn(summary.counters, counter),
        `missing zero-presence counter ${counter}`,
      ).toBe(true);
    });
  });
});
