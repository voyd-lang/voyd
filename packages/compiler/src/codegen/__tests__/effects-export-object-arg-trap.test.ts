import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import { runEffectfulExport, parseEffectTable } from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-export-object-arg-trap.voyd"
);

const buildModule = () => {
  const source = readFileSync(fixturePath, "utf8");
  return codegen(
    semanticsPipeline(parse(source, "/proj/src/effects-export-object-arg-trap.voyd"))
  );
};

describe("effectful exports with non-i32 args", () => {
  it("traps when an effect with unsupported args escapes to JS", async () => {
    const { module } = buildModule();
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
