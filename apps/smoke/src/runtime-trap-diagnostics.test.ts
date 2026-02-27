import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult, type VoydRuntimeError } from "@voyd/sdk";

const fixtureEntryPath = path.join(
  import.meta.dirname,
  "..",
  "fixtures",
  "runtime-trap-diagnostics.voyd"
);

const TRAP_EFFECT_ID = "com.example.trap";

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  expect(result.success).toBe(true);
  return result;
};

const expectRuntimeTrap = async (
  run: Promise<unknown>
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

describe("smoke: runtime trap diagnostics", () => {
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(await sdk.compile({ entryPath: fixtureEntryPath }));
  });

  it("surfaces module/function/span diagnostics for pure wasm traps", async () => {
    const error = await expectRuntimeTrap(compiled.run({ entryName: "pure_trap" }));

    expect(error.stack).toContain("wasm://wasm/");
    expect(error.voyd.trap.functionName).toBe("pure_trap");
    expect(error.voyd.trap.moduleId).toBeTruthy();
    expect(error.voyd.trap.span?.file).toContain("runtime-trap-diagnostics.voyd");
    expect(error.voyd.trap.span?.startLine).toBeGreaterThan(0);
    expect(error.voyd.trap.span?.startColumn).toBeGreaterThan(0);
  });

  it("surfaces effect op context for traps that happen after resume", async () => {
    const error = await expectRuntimeTrap(
      compiled.run({
        entryName: "effectful_trap",
        handlers: {
          [`${TRAP_EFFECT_ID}::denom`]: ({ resume }) => resume(0),
        },
      })
    );

    expect(error.stack).toContain("wasm://wasm/");
    expect(error.voyd.trap.functionName).toBe("effectful_trap");
    expect(error.voyd.effect?.effectId).toBe(TRAP_EFFECT_ID);
    expect(error.voyd.effect?.opName).toBe("denom");
    expect(error.voyd.effect?.continuationBoundary).toBe("resume");
    expect(error.voyd.transition?.point).toBe("resume_effectful");
    expect(error.voyd.transition?.direction).toBe("host->vm");
  });
});
