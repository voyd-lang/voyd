import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compileEffectFixture } from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-export-object-arg-trap.voyd"
);

const compileFixture = () =>
  compileEffectFixture({ entryPath: fixturePath, throwOnError: false });

describe("effectful exports with non-i32 args", () => {
  it("fails codegen with a host-boundary payload compatibility diagnostic", async () => {
    const result = await compileFixture();
    const diagnostic = result.diagnostics.find(
      (diag) =>
        diag.code === "CG0001" &&
        diag.message.includes("HostOnly.poke arg1") &&
        diag.message.includes("Supported payload categories")
    );
    expect(diagnostic).toBeDefined();
  });
});
