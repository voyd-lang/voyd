import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/parser.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import {
  runEffectfulExport,
  type EffectHandler,
} from "./support/effects-harness.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-continuation-compiler.voyd"
);

describe("continuation compiler", () => {
  it("resumes without re-running prefix control flow", async () => {
    const source = readFileSync(fixturePath, "utf8");
    const semantics = semanticsPipeline(
      parse(source, "/proj/src/effects-continuation-compiler.voyd")
    );
    const { module } = codegen(semantics);
    if (process.env.DEBUG_EFFECTS_WAT === "1") {
      writeFileSync(
        "debug-effects-continuation-compiler.wat",
        module.emitText()
      );
    }
    const observed: number[] = [];
    const handler: EffectHandler = (_request, value) => {
      observed.push(value as number);
      return value as number;
    };
    const blockResult = await runEffectfulExport<number>({
      wasm: module,
      entryName: "block_test_effectful",
      handlers: {
        "0:0:0": handler,
      },
    });
    expect(blockResult.value).toBe(6);
    expect(observed).toEqual([5]);
    observed.length = 0;

    const whileResult = await runEffectfulExport<number>({
      wasm: module,
      entryName: "while_test_effectful",
      handlers: {
        "0:0:0": handler,
      },
    });
    expect(observed).toEqual([1, 2, 3, 4, 5]);
    expect(whileResult.value).toBe(15);
  });
});
