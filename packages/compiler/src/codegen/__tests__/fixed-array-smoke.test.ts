import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getWasmInstance } from "@voyd/lib/wasm.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import type { ModuleGraph, ModuleNode } from "../../modules/types.js";

const loadExports = (): Record<string, CallableFunction> => {
  const source = readFileSync(
    resolve(import.meta.dirname, "__fixtures__", "fixed_array_smoke.voyd"),
    "utf8"
  );
  const fixture = "fixed_array_smoke.voyd";
  const ast = parse(source, fixture);
  const moduleNode: ModuleNode = {
    id: "std::fixed_array_smoke",
    path: { namespace: "std", segments: ["fixed_array_smoke"] },
    origin: { kind: "file", filePath: fixture },
    ast,
    source,
    dependencies: [],
  };
  const graph: ModuleGraph = {
    entry: moduleNode.id,
    modules: new Map([[moduleNode.id, moduleNode]]),
    diagnostics: [],
  };
  const semantics = semanticsPipeline({ module: moduleNode, graph });
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
