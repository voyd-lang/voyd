import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { createVoydHost } from "@voyd-lang/js-host";
import { compileEffectFixture } from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-imported-std-fs-handler.voyd",
);

describe("imported std fs effect handlers", () => {
  it("compiles and runs handlers for imported std::fs::Fs ops", async () => {
    const { wasm } = await compileEffectFixture({
      entryPath: fixturePath,
      codegenOptions: { effectsHostBoundary: "off" },
    });
    const host = await createVoydHost({ wasm });

    await expect(host.run<number>("handle_imported_std_fs_ops")).resolves.toBe(28);
  });
});
