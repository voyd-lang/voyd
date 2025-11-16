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
});
