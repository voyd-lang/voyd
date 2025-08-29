import { genericsUnionInferNegativeVoyd } from "./fixtures/generics-union-infer-negative.js";
import { compile } from "../compiler.js";
import { describe, test } from "vitest";

describe("E2E union generic inference (negative)", () => {
  test("rejects arg union that is a strict superset of parameter union", async (t) => {
    await t.expect(compile(genericsUnionInferNegativeVoyd)).rejects.toThrow();
  });
});

