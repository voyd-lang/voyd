import { afterEach, describe, expect, it, vi } from "vitest";

const SOURCE = `fn answer() -> i32
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
  });
});
