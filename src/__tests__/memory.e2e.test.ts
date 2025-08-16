import { linearMemoryVoyd } from "./fixtures/memory.js";
import { compile } from "../compiler.js";
import { beforeAll, describe, test } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E linear memory", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(linearMemoryVoyd);
    instance = getWasmInstance(mod);
  });

  test("load/store roundtrip", (t) => {
    const fn = getWasmFn("run", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "run returns stored value").toEqual(42);
  });
});
