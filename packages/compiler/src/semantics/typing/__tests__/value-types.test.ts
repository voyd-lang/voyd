import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { DiagnosticError } from "../../../diagnostics/index.js";

describe("value types", () => {
  it("rejects implicit trait-object widening from value types", () => {
    let caught: unknown;
    try {
      semanticsPipeline(loadAst("value_trait_object_widening.voyd"));
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0045");
    expect(caught.diagnostic.message).toContain("trait object");
    expect(caught.diagnostic.related?.[0]?.severity).toBe("note");
    expect(caught.diagnostic.related?.[0]?.message).toContain("explicit boxing");
  });

  it("rejects mutable receiver calls on temporary value expressions", () => {
    let caught: unknown;
    try {
      semanticsPipeline(loadAst("value_mutable_temporary.voyd"));
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0045");
    expect(caught.diagnostic.message).toContain("temporary value");
  });

  it("rejects recursive value declarations", () => {
    let caught: unknown;
    try {
      semanticsPipeline(loadAst("value_recursive_direct.voyd"));
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0045");
    expect(caught.diagnostic.message).toContain("recursively contains itself");
  });

  it("rejects value fields without a fixed-layout compatible type", () => {
    let caught: unknown;
    try {
      semanticsPipeline(loadAst("value_invalid_field_type.voyd"));
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0045");
    expect(caught.diagnostic.message).toContain("fixed-layout value-compatible type");
    expect(caught.diagnostic.message).toContain("payload");
  });

  it("rejects direct unions that mix value and heap members", () => {
    let caught: unknown;
    try {
      semanticsPipeline(loadAst("value_mixed_union_alias.voyd"));
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0046");
    expect(caught.diagnostic.message).toContain("Left");
    expect(caught.diagnostic.message).toContain("Right");
    expect(caught.diagnostic.message).toContain("top-level union members must be value types");
  });

  it("rejects inferred unions that mix value and heap members", () => {
    let caught: unknown;
    try {
      semanticsPipeline(loadAst("value_mixed_union_inferred_return.voyd"));
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0046");
    expect(caught.diagnostic.message).toContain("Left");
    expect(caught.diagnostic.message).toContain("Right");
  });
});
