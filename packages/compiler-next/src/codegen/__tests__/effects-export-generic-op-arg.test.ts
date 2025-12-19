import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import { runEffectfulExport } from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-export-generic-op-arg.voyd"
);

const buildModule = () => {
  const source = readFileSync(fixturePath, "utf8");
  return codegen(
    semanticsPipeline(parse(source, "/proj/src/effects-export-generic-op-arg.voyd"))
  );
};

describe("effectful exports with generic effect args", () => {
  it("encodes concrete args for generic effect operations", async () => {
    const { module } = buildModule();
    const handlers = {
      "0:0:0": (_request: unknown, value: number) => value + 1,
    };

    const result = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers,
    });

    expect(result.value).toBe(42);
  });
});
