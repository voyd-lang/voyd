import { msgPackOptionalOmitVoyd } from "./fixtures/msg-pack-optional-omit.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("E2E Optional<T> match with omitted type param", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(msgPackOptionalOmitVoyd);
    instance = getWasmInstance(mod);
  });

  test("main returns expected (no cast trap)", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "main exists");
    t.expect(fn()).toEqual(1);
  });
});

