import assert from "node:assert";
import { beforeAll, describe, test } from "vitest";

import { compile } from "../compiler.js";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";
import { mapRecursiveUnionVoyd } from "./fixtures/map-recursive-union.js";

describe("Map recursive union regression", () => {
  let instance: WebAssembly.Instance;

  beforeAll(async () => {
    const mod = await compile(mapRecursiveUnionVoyd);
    assert(mod.validate(), "Module is valid");
    instance = getWasmInstance(mod);
  });

  test("unions share canonical map type", (t) => {
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn()).toEqual(1);
  });
});

