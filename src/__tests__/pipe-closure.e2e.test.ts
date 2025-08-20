import { pipeClosureVoyd } from "./fixtures/pipe-closure.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E closure piping", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(pipeClosureVoyd);
    instance = getWasmInstance(mod);
  });

  test("pipes value through closures", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "main returns piped closure result").toEqual(25);
  });
});
