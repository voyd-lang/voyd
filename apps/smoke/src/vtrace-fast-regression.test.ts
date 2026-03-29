import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createSdk, type CompileResult } from "@voyd-lang/sdk";
import { createVoydHost } from "@voyd-lang/sdk/js-host";

const fixtureEntryPath = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "voyd_examples",
  "src",
  "vtrace_fast.voyd",
);

const expectCompileSuccess = (
  result: CompileResult,
): Extract<CompileResult, { success: true }> => {
  if (!result.success) {
    throw new Error(result.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  expect(result.success).toBe(true);
  return result;
};

const vtraceFastIt = fs.existsSync(fixtureEntryPath) ? it : it.skip;

describe("smoke: vtrace_fast regression", () => {
  let compiled: Extract<CompileResult, { success: true }>;

  beforeAll(async () => {
    const sdk = createSdk();
    compiled = expectCompileSuccess(await sdk.compile({ entryPath: fixtureEntryPath }));
  });

  vtraceFastIt("still compiles cleanly against the current std/compiler stack", async () => {
    expect(compiled.wasm.byteLength).toBeGreaterThan(0);
  });

  vtraceFastIt(
    "keeps lower-half pixels lit instead of collapsing to black",
    { timeout: 120_000 },
    async () => {
      const writes: string[] = [];
      const host = await createVoydHost({
        wasm: compiled.wasm,
        defaultAdapters: {
          runtime: "node",
          runtimeHooks: {
            write: async ({ target, value }) => {
              if (target === "stdout") {
                writes.push(value);
              }
            },
            writeBytes: async () => {},
            flush: async () => {},
            isOutputTty: () => false,
          },
        },
      });

      await host.run<void>("main");

      const ppm = writes.join("");
      expect(ppm.length).toBeGreaterThan(200_000);

      const pixels = ppm.trim().split(/\s+/).slice(4).map(Number);
      const lowerHalfPixelCount = 56 * 200;
      const lowerHalfStart = 56 * 200 * 3;
      const lowerHalf = pixels.slice(lowerHalfStart);
      const lowerHalfBrightness =
        lowerHalf.reduce((sum, channel) => sum + channel, 0) /
        (lowerHalfPixelCount * 3);

      expect(lowerHalfBrightness).toBeGreaterThan(20);
    },
  );
});
