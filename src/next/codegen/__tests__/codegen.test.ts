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

const loadWasmInstance = (fixtureName: string) => {
  const ast = loadAst(fixtureName);
  const semantics = semanticsPipeline(ast);
  const { module } = codegen(semantics);
  return getWasmInstance(module);
};

const loadMain = (fixtureName: string) => {
  const instance = loadWasmInstance(fixtureName);
  const main = instance.exports.main;
  expect(typeof main).toBe("function");
  return main as (...params: unknown[]) => unknown;
};

describe("next codegen", () => {
  it("emits wasm for the fib sample and runs main()", () => {
    const main = loadMain("fib.voyd");
    expect(main()).toBe(55);
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
    const main = loadMain("var_inference.voyd");
    expect(main()).toBe(55);
  });

  it("emits wasm for the recursive inference sample and runs main()", () => {
    const main = loadMain("recursive_inference.voyd");
    expect(main()).toBe(120);
  });

  it("emits wasm for the function overloads sample and runs both call sites", () => {
    const instance = loadWasmInstance("function_overloads.voyd");

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
    const main = loadMain("elif.voyd");
    expect(main()).toBe(0);
  });

  it("emits wasm for structural object literals and spreads", () => {
    const main = loadMain("structural_objects.voyd");
    expect(main()).toBe(21);
  });

  it("emits wasm for nominal objects and structural interop", () => {
    const main = loadMain("nominal_objects.voyd");
    expect(main()).toBe(21);
  });

  it("emits wasm for nominal objects with type parameters", () => {
    const main = loadMain("object_generics.voyd");
    expect(main()).toBe(7);
  });

  it("emits wasm for tuples treated as structural objects", () => {
    const main = loadMain("tuples.voyd");
    expect(main()).toBe(32);
  });

  it("emits wasm for UFCS calls to free functions", () => {
    const main = loadMain("ufcs.voyd");
    expect(main()).toBe(19);
  });

  it("emits wasm for union matches and returns the matched payload", () => {
    const main = loadMain("unions_match.voyd");

    expect(main()).toBe(1);
  });

  it("preserves nominal identity for structurally identical types in match guards", () => {
    const main = loadMain("nominal_identity_match.voyd");
    expect(main()).toBe(303);
  });

  it("includes base nominal ancestors for derived casts", () => {
    const main = loadMain("nominal_inheritance_match.voyd");
    expect(main()).toBe(7);
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
    const main = loadMain("type_alias_generics.voyd");
    expect(main()).toBe(12);
  });

  it("emits wasm for generic functions", () => {
    const instance = loadWasmInstance("function_generics.voyd");
    const main1 = instance.exports.main1;
    const main2 = instance.exports.main2;
    expect(typeof main1).toBe("function");
    expect(typeof main2).toBe("function");
    expect((main1 as () => number)()).toBeCloseTo(3);
    expect((main2 as () => number)()).toBe(3);
  });
});
