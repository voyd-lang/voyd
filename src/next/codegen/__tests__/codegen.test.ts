import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getWasmInstance } from "../../../lib/wasm.js";
import { codegen } from "../index.js";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";

const loadAst = (fixtureName: string) => {
  const source = readFileSync(
    resolve(import.meta.dirname, "__fixtures__", fixtureName),
    "utf8"
  );
  return parse(source, fixtureName);
};

describe("next codegen", () => {
  it("emits wasm for the fib sample and runs main()", () => {
    const ast = loadAst("fib.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(55);
  });

  it("uses return_call for tail-recursive functions", () => {
    const ast = loadAst("tail_fib.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const text = module.emitText();
    expect(text).toContain("return_call");
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(55);
  });

  it("emits wasm for the var inference sample and runs main()", () => {
    const ast = loadAst("var_inference.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(55);
  });

  it("emits wasm for the recursive inference sample and runs main()", () => {
    const ast = loadAst("recursive_inference.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(120);
  });

  it("emits wasm for the function overloads sample and runs both call sites", () => {
    const ast = loadAst("function_overloads.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const instance = getWasmInstance(module);

    const callInt = instance.exports.call_int;
    expect(typeof callInt).toBe("function");
    expect((callInt as () => number)()).toBe(3);

    const callFloat = instance.exports.call_float;
    expect(typeof callFloat).toBe("function");
    expect((callFloat as () => number)()).toBeCloseTo(3);

    const callFrom = instance.exports.call_from;
    expect(typeof callFrom).toBe("function");
    expect((callFrom as () => number)()).toBe(-1);

    const callTo = instance.exports.call_to;
    expect(typeof callTo).toBe("function");
    expect((callTo as () => number)()).toBe(3);
  });

  it("emits wasm for the elif sample and runs main()", () => {
    const ast = loadAst("elif.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(0);
  });

  it("emits wasm for structural object literals and spreads", () => {
    const ast = loadAst("structural_objects.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(21);
  });

  it("emits wasm for nominal objects and structural interop", () => {
    const ast = loadAst("nominal_objects.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(21);
  });

  it("emits wasm for nominal objects with type parameters", () => {
    const ast = loadAst("object_generics.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(7);
  });

  it("emits wasm for tuples treated as structural objects", () => {
    const ast = loadAst("tuples.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(32);
  });

  it("emits wasm for UFCS calls to free functions", () => {
    const ast = loadAst("ufcs.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(19);
  });

  it("emits wasm for union matches and returns the matched payload", () => {
    const ast = loadAst("unions_match.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(1);
  });

  it("preserves nominal identity for structurally identical types in match guards", () => {
    const ast = loadAst("nominal_identity_match.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(303);
  });

  it("emits wasm for type aliases with type parameters", () => {
    const ast = loadAst("type_alias_generics.voyd");
    const semantics = semanticsPipeline(ast);
    const { module } = codegen(semantics);
    const instance = getWasmInstance(module);
    const main = instance.exports.main;
    expect(typeof main).toBe("function");
    expect((main as () => number)()).toBe(12);
  });
});
