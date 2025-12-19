import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";

const loadExports = (): Record<string, CallableFunction> => {
  const source = readFileSync(
    resolve(import.meta.dirname, "__fixtures__", "fixed_array_smoke.voyd"),
    "utf8"
  );
  const ast = parse(source, "fixed_array_smoke.voyd");
  const semantics = semanticsPipeline(ast);
  const { module } = codegen(semantics);
  const instance = getWasmInstance(module);
  return instance.exports as Record<string, CallableFunction>;
};

describe("FixedArray smoke e2e", () => {
  it("compiles and wires fixed-array helpers", () => {
    const exports = loadExports();
    expect(typeof exports.len_and_head).toBe("function");
    expect(typeof exports.copy_tail).toBe("function");
    expect(typeof exports.iterate_sum).toBe("function");
    expect((exports.len_and_head as () => number)()).toBe(4);
    expect((exports.copy_tail as () => number)()).toBe(2);
    expect((exports.iterate_sum as () => number)()).toBe(6);
  });
});
