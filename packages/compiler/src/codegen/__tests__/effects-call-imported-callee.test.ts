import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileEffectFixture,
  parseEffectTable,
} from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-call-imported-callee",
  "pkg.voyd",
);

describe("effects call imported callee", () => {
  it("compiles effectful imported direct calls with effectful args", async () => {
    const { module } = await compileEffectFixture({ entryPath: fixturePath });
    const parsed = parseEffectTable(module);
    const awaitOp = parsed.ops.find((op) => op.label.endsWith("Async.await"));
    if (!awaitOp) {
      throw new Error("missing Async.await op entry");
    }
    expect(awaitOp.opIndex).toBeGreaterThanOrEqual(0);
  });
});
