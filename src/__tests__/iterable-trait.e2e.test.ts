import { iterableVoyd } from "./fixtures/iterable.js";
import { compile } from "../compiler.js";
import { describe, test } from "vitest";
describe("E2E generic trait objects", () => {
  test("calls method on generic trait object", async (t) => {
    await t.expect(compile(iterableVoyd)).resolves.toBeTruthy();
  });
});
