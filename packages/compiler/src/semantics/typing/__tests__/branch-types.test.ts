import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";

describe("branch result typing", () => {
  it("rejects incompatible if branch result types", () => {
    const ast = loadAst("branch_type_mismatch.voyd");
    expect(() => semanticsPipeline(ast)).toThrow(/branch type mismatch/i);
  });

  it("allows incompatible if branch types when used as a statement", () => {
    const ast = loadAst("if_statement_branch_type_mismatch_ok.voyd");
    expect(() => semanticsPipeline(ast)).not.toThrow();
  });

  it("allows incompatible if branch types at end of while body", () => {
    const ast = loadAst("while_body_discard_value_if_branch_types_ok.voyd");
    expect(() => semanticsPipeline(ast)).not.toThrow();
  });

  it("accepts case-style while loops", () => {
    const ast = loadAst("while_case_form.voyd");
    expect(() => semanticsPipeline(ast)).not.toThrow();
  });
});
