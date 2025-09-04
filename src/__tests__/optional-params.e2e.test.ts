import { optionalParamsVoyd } from "./fixtures/optional-params.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("optional parameters", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(optionalParamsVoyd);
    instance = getWasmInstance(mod);
  });

  test("unlabeled optional parameter", (t) => {
    const withMiddle = getWasmFn("greet_with_middle", instance);
    assert(withMiddle, "Function exists");
    t.expect(withMiddle()).toEqual(2);

    const withoutMiddle = getWasmFn("greet_without_middle", instance);
    assert(withoutMiddle, "Function exists");
    t.expect(withoutMiddle()).toEqual(1);
  });

  test("labeled optional parameter", (t) => {
    const withSub = getWasmFn("banner_with_subtitle", instance);
    assert(withSub, "Function exists");
    t.expect(withSub()).toEqual(2);

    const withoutSub = getWasmFn("banner_without_subtitle", instance);
    assert(withoutSub, "Function exists");
    t.expect(withoutSub()).toEqual(1);
  });
});
