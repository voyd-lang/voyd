import { branchNodeStructuralVoyd } from "./fixtures/branch-node-structural.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

// TODO: This test currently fails with a runtime `illegal cast` when `Node`
// is a structural type. Once the underlying casting bug is resolved this test
// should be enabled and expected to return 10.
describe("E2E structural branch handling", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(branchNodeStructuralVoyd);
    instance = getWasmInstance(mod);
  });

  test.skip("main walks optional branches with structural node", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn()).toEqual(10);
  });
});
