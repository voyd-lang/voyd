import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileEffectFixture,
  parseEffectTable,
  runEffectfulExport,
} from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-export-generic-op-arg.voyd"
);

describe("effect signature validation", () => {
  it("fails fast on signature hash mismatches", async () => {
    const { module } = await compileEffectFixture({ entryPath: fixturePath });
    const table = parseEffectTable(module);
    const op = table.ops[0];
    if (!op) {
      throw new Error("missing effect op entry");
    }
    const badKey = `${op.effectId}:${op.opId}:${op.signatureHash + 1}`;
    await expect(
      runEffectfulExport<number>({
        wasm: module,
        entryName: "main_effectful",
        handlers: { [badKey]: () => 1 },
      })
    ).rejects.toThrow(/Missing handlers/);
  });
});
