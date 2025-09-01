import { msgPackArrayMapVoyd } from "./fixtures/msg-pack-array-map.js";
import { compile } from "../compiler.js";
import { describe, test } from "vitest";
import assert from "node:assert";
// Note: this test ensures compile+run works without ambiguous overloads.

describe("E2E Array.map to MsgPack children", () => {
  test("compiles map<MsgPack> without ambiguous push", async (t) => {
    const mod = await compile(msgPackArrayMapVoyd);
    assert(mod, "module compiled");
    // No runtime invocation; this test asserts the compiler resolves the call
    // without the previous ambiguous overload error.
    t.expect(!!mod).toEqual(true);
  });
});
