import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";

describe("branch result typing", () => {
  it("rejects incompatible if branch result types", () => {
    const ast = loadAst("branch_type_mismatch.voyd");
    expect(() => semanticsPipeline(ast)).toThrow(/branch type mismatch/i);
  });
});
