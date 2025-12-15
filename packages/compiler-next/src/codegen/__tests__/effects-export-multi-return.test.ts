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
  "effects-export-multi-return.voyd"
);

const buildModule = () => {
  const source = readFileSync(fixturePath, "utf8");
  return codegen(semanticsPipeline(parse(source, "/proj/src/effects-export-multi-return.voyd")));
};

describe("effectful exports with different return types", () => {
  it("runs both i32 and void effectful exports through the host boundary", async () => {
    const { module } = buildModule();
    const handlers = {
      "0:0:1": () => 2,
      "1:0:0": () => 0,
    };

    const main = await runEffectfulExport<number>({
      wasm: module,
      entryName: "main_effectful",
      handlers,
    });
    expect(main.value).toBe(3);

    const done = await runEffectfulExport<null>({
      wasm: module,
      entryName: "done_effectful",
      handlers,
    });
    expect(done.value).toBeNull();
  });
});
