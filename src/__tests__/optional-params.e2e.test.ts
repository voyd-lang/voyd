import {
  optionalParamsVoyd,
  leftoverArgVoyd,
  requiredOptionalVoyd,
} from "./fixtures/optional-params.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "@lib/wasm.js";

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

  test("skipping optional parameter before labeled arg", (t) => {
    const skip = getWasmFn("skip_optional_labeled", instance);
    assert(skip, "Function exists");
    t.expect(skip()).toEqual(3);
  });

  test("reject leftover argument after skipping optional", async (t) => {
    await t.expect(compile(leftoverArgVoyd)).rejects.toThrow();
  });

  test("required Optional<T> parameter is not optional", async (t) => {
    await t.expect(compile(requiredOptionalVoyd)).rejects.toThrow();
  });

  test("labeled optional parameter", (t) => {
    const withSub = getWasmFn("banner_with_subtitle", instance);
    assert(withSub, "Function exists");
    t.expect(withSub()).toEqual(2);

    const withoutSub = getWasmFn("banner_without_subtitle", instance);
    assert(withoutSub, "Function exists");
    t.expect(withoutSub()).toEqual(1);

    const withoutSubObj = getWasmFn(
      "banner_obj_without_subtitle",
      instance
    );
    assert(withoutSubObj, "Function exists");
    t.expect(withoutSubObj()).toEqual(1);
  });

  test("closure optional parameter", (t) => {
    const withArg = getWasmFn("closure_with_arg", instance);
    assert(withArg, "Function exists");
    t.expect(withArg()).toEqual(2);

    const withoutArg = getWasmFn("closure_without_arg", instance);
    assert(withoutArg, "Function exists");
    t.expect(withoutArg()).toEqual(1);
  });
});
