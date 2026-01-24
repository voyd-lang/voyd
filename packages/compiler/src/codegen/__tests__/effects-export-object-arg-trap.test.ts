import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compileEffectFixture,
  runEffectfulExport,
  parseEffectTable,
} from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-export-object-arg-trap.voyd"
);

const buildModule = () => compileEffectFixture({ entryPath: fixturePath });

describe("effectful exports with non-i32 args", () => {
  it("traps when an effect with unsupported args escapes to JS", async () => {
    const { module } = await buildModule();
    const parsed = parseEffectTable(module);
    const op = parsed.ops[0];
    if (!op) {
      throw new Error("missing effect op entry");
    }
    await expect(
      runEffectfulExport<number>({
        wasm: module,
        entryName: "main_effectful",
        handlers: { [`${op.opIndex}`]: () => 1 },
      })
    ).rejects.toThrow();
  });
});
