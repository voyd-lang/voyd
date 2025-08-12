import { objectLiteralArgsVoyd } from "./fixtures/object-literal-args.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";

describe("object literal call arguments", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(objectLiteralArgsVoyd);
    instance = getWasmInstance(mod);
  });

  test("move called with object literal", (t) => {
    const fn = getWasmFn("call_move", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "call_move returns correct value").toEqual(6);
  });
});
