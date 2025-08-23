import { miniJsonVoyd } from "./fixtures/mini-json.js";
import { compile } from "../compiler.js";
import { describe, test } from "vitest";
import assert from "node:assert";

describe("E2E MiniJson unions", () => {
  test("casts call arguments to union type", async (t) => {
    const mod = await compile(miniJsonVoyd);
    assert(mod.validate(), "Module is valid");
    t.expect(mod.emitText()).toContain("ref.cast");
  });
});
