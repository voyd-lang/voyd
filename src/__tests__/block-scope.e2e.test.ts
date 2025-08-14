import { blockScopeVoyd } from "./fixtures/block-scope.js";
import { compile } from "../compiler.js";
import { describe, test } from "vitest";

describe("E2E block scoping", () => {
  test("variable defined in block is not accessible outside", async (t) => {
    await t.expect(compile(blockScopeVoyd)).rejects.toThrow();
  });
});
