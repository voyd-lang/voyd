import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CompileOptions,
  CompileResult,
  OptimizationLevel,
} from "@voyd-lang/sdk";

const SOURCE = `
fn add_one(value: i32) -> i32
  value + 1

pub fn main() -> i32
  add_one(41)
`;

const LEVELS: readonly OptimizationLevel[] = ["none", "balanced", "release"];

describe("SDK optimization levels", () => {
  afterEach(() => {
    delete process.env.VOYD_COMPILER_PERF;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("compiles and runs every level while preserving optimize boolean compatibility", async () => {
    process.env.VOYD_COMPILER_PERF = "1";
    vi.resetModules();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { createSdk } = await import("@voyd-lang/sdk");
    const sdk = createSdk();
    const compile = async (
      options: Pick<CompileOptions, "optimizationLevel" | "optimize">,
    ) => {
      const callCount = errorSpy.mock.calls.length;
      const result = expectCompileSuccess(
        await sdk.compile({
          source: SOURCE,
          ...options,
        }),
      );
      const perfLine = errorSpy.mock.calls
        .slice(callCount)
        .map(([message]) => String(message))
        .find((message) => message.startsWith(PERF_PREFIX));
      if (!perfLine) {
        throw new Error("Expected compiler performance summary");
      }
      const summary = JSON.parse(perfLine.slice(PERF_PREFIX.length)) as {
        counters: Record<string, number>;
      };
      return { result, counters: summary.counters };
    };

    const tiers = new Map<
      OptimizationLevel,
      Awaited<ReturnType<typeof compile>>
    >();
    for (const optimizationLevel of LEVELS) {
      const compiled = await compile({ optimizationLevel });
      await expect(
        compiled.result.run<number>({ entryName: "main" }),
      ).resolves.toBe(42);
      tiers.set(optimizationLevel, compiled);
    }

    const legacyNone = await compile({ optimize: false });
    const legacyRelease = await compile({ optimize: true });
    const explicitLevelWins = await compile({
      optimizationLevel: "none",
      optimize: true,
    });

    expect(optimizationProfiles(tiers.get("none")?.counters)).toEqual([]);
    expect(optimizationProfiles(tiers.get("balanced")?.counters)).toEqual([
      "binaryen.profile.balanced.runs",
    ]);
    expect(optimizationProfiles(tiers.get("release")?.counters)).toEqual([
      "binaryen.profile.release.runs",
    ]);
    expect(optimizationProfiles(legacyNone.counters)).toEqual([]);
    expect(optimizationProfiles(legacyRelease.counters)).toEqual([
      "binaryen.profile.release.runs",
    ]);
    expect(optimizationProfiles(explicitLevelWins.counters)).toEqual([]);
    expect(hasSemanticOptimizerPasses(tiers.get("none")?.counters)).toBe(false);
    expect(hasSemanticOptimizerPasses(tiers.get("balanced")?.counters)).toBe(
      true,
    );
    expect(hasSemanticOptimizerPasses(tiers.get("release")?.counters)).toBe(
      true,
    );
    expect(hasSemanticOptimizerPasses(legacyNone.counters)).toBe(false);
    expect(hasSemanticOptimizerPasses(legacyRelease.counters)).toBe(true);
    expect(hasSemanticOptimizerPasses(explicitLevelWins.counters)).toBe(false);
  }, 120_000);

  it("returns a diagnostic for an invalid JavaScript level value", async () => {
    const { createSdk } = await import("@voyd-lang/sdk");
    const result = await createSdk().compile({
      source: SOURCE,
      optimizationLevel: "balance" as OptimizationLevel,
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected compilation to fail");
    }
    expect(
      result.diagnostics.map(({ message }) => message).join("\n"),
    ).toContain('unknown optimization level "balance"');
  });
});

const PERF_PREFIX = "[voyd:compiler:perf] ";

const optimizationProfiles = (
  counters: Readonly<Record<string, number>> | undefined,
): string[] =>
  Object.keys(counters ?? {}).filter((name) =>
    name.startsWith("binaryen.profile."),
  );

const hasSemanticOptimizerPasses = (
  counters: Readonly<Record<string, number>> | undefined,
): boolean =>
  Object.keys(counters ?? {}).some((name) =>
    name.startsWith("optimize.pass.0."),
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
