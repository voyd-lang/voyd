import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "../../parser/index.js";
import { semanticsPipeline } from "../../semantics/pipeline.js";
import { codegen } from "../index.js";

const fixturePath = resolve(
  import.meta.dirname,
  "__fixtures__",
  "effects-wasm-object-arg.voyd"
);

const buildModule = () => {
  const source = readFileSync(fixturePath, "utf8");
  const semantics = semanticsPipeline(
    parse(source, "/proj/src/effects-wasm-object-arg.voyd")
  );
  return codegen(semantics);
};

describe("effects wasm object args", () => {
  it("passes object arguments to in-wasm handlers", () => {
    const { module } = buildModule();
    const wasmBinary = new Uint8Array(module.emitBinary());
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(wasmBinary),
      {}
    );
    const main = instance.exports.main as CallableFunction;
    expect(main()).toBe(42);
  });
});

