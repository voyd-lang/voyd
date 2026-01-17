import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";
import { createEffectsImports } from "./support/wasm-imports.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-wasm-overloads-alias.voyd"
);

const buildModule = () => {
  const source = readFileSync(fixturePath, "utf8");
  const semantics = semanticsPipeline(
    parse(source, "/proj/src/effects-wasm-overloads-alias.voyd")
  );
  return codegen(semantics);
};

describe("effect handler overloads with aliases", () => {
  it("selects overloads based on semantic types", () => {
    const { module } = buildModule();
    const wasmBinary = new Uint8Array(module.emitBinary());
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBinary),
      createEffectsImports()
    );
    const main = instance.exports.main as CallableFunction;
    expect(main()).toBe(12);
  });
});
