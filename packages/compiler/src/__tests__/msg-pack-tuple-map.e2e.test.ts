import { msgPackTupleMapVoyd } from "./fixtures/msg-pack-tuple-map.js";
import { compile } from "../compiler.js";
import { describe, test, beforeAll } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "@voyd/lib/wasm.js";

describe("E2E Map<MsgPack> from Array<(String, MsgPack)>", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(msgPackTupleMapVoyd);
    instance = getWasmInstance(mod);
  });

  test("main returns expected (no cast trap)", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "main exists");
    t.expect(fn()).toEqual(1);
  });
});

