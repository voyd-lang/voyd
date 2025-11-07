import { branchNodeVoyd } from "./fixtures/branch-node.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "@lib/wasm.js";

describe("E2E optional branch handling", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(branchNodeVoyd);
    instance = getWasmInstance(mod);
  });

  test("main walks optional branches", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn()).toEqual(10);
  });
});
