import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getWasmInstance } from "../../../lib/wasm.js";
import { codegen } from "../index.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";

describe("next codegen", () => {
  it("emits wasm for the fib sample and runs main()", () => {
    const relPath = "sb/fib.voyd";
    const source = readFileSync(resolve(process.cwd(), relPath), "utf8");
    const ast = parse(source, relPath);
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(55);
  });
});
