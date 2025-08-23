import { arrayStructUnionVoyd } from "./fixtures/array-struct-union.js";
import { compile } from "../compiler.js";
import { describe, test } from "vitest";
import assert from "node:assert";

describe("arrays with structural unions", () => {
  test("casts nested union array arguments", async (t) => {
    const mod = await compile(arrayStructUnionVoyd);
    assert(mod.validate(), "Module is valid");
    t.expect(mod.emitText()).toContain("ref.cast");
  });
});
