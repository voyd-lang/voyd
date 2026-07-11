import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createSdk,
  type CompileResult,
  type OptimizationLevel,
  type VoydRuntimeError,
} from "@voyd-lang/sdk";

const fixtureEntryPath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "optimization-differential.voyd",
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

const expectRuntimeTrap = async (
  run: Promise<unknown>,
): Promise<VoydRuntimeError> => {
  try {
    await run;
    throw new Error("expected runtime trap");
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    const runtimeError = error as VoydRuntimeError;
    expect(runtimeError.voyd.kind).toBe("wasm-trap");
    return runtimeError;
  }
};

const LEVELS: readonly OptimizationLevel[] = ["none", "balanced", "release"];

describe("integration: optimization-level differential behavior", () => {
  let compiledByLevel: Map<
    OptimizationLevel,
    Extract<CompileResult, { success: true }>
  >;

  beforeAll(async () => {
    const sdk = createSdk();
    compiledByLevel = new Map();
    for (const optimizationLevel of LEVELS) {
      compiledByLevel.set(
        optimizationLevel,
        expectCompileSuccess(
          await sdk.compile({
            entryPath: fixtureEntryPath,
            optimizationLevel,
            runtimeDiagnostics: true,
          }),
        ),
      );
    }
  });

  it("emits valid WebAssembly at every optimization level", () => {
    LEVELS.forEach((level) => {
      expect(
        WebAssembly.validate(compiledByLevel.get(level)!.wasm as BufferSource),
      ).toBe(true);
    });
  });

  it.each([
    ["folded_branch", 42],
    ["trait_dispatch", 9],
    ["heap_alias_identity", 10],
    ["handled_effect_wide_return", 6],
  ] as const)("preserves %s results", async (entryName, expected) => {
    const results = await Promise.all(
      LEVELS.map((level) =>
        compiledByLevel.get(level)!.run<number>({ entryName }),
      ),
    );
    expect(results).toEqual(LEVELS.map(() => expected));
  });

  it("preserves deliberate trap diagnostics", async () => {
    const errors = await Promise.all(
      LEVELS.map((level) =>
        expectRuntimeTrap(
          compiledByLevel.get(level)!.run({ entryName: "deliberate_trap" }),
        ),
      ),
    );

    const semanticTrap = (error: VoydRuntimeError) => ({
      kind: error.voyd.kind,
      functionName: error.voyd.trap.functionName,
      moduleId: error.voyd.trap.moduleId,
      sourceFile: error.voyd.trap.span?.file,
      sourceLine: error.voyd.trap.span?.startLine,
      sourceColumn: error.voyd.trap.span?.startColumn,
    });

    expect(errors.map(semanticTrap)).toEqual(
      LEVELS.map(() => semanticTrap(errors[0]!)),
    );
    expect(errors[0]!.voyd.trap.functionName).toBe("deliberate_trap");
    expect(errors[0]!.voyd.trap.span?.file).toContain(
      "optimization-differential.voyd",
    );
  });
});
