import { structBranchNodeVoyd } from "./fixtures/struct-branch-node.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E structural optional branch handling", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(structBranchNodeVoyd);
    instance = getWasmInstance(mod);
  });

  test.skip("main walks structural branches", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn()).toEqual(10);
  });
});
