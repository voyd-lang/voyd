import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { DiagnosticError } from "../../../diagnostics/index.js";

describe("object mutability", () => {
  it("rejects field assignment on immutable object bindings", () => {
    const ast = loadAst("immutable_object_field_assignment.voyd");

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0004");
    expect(caught.diagnostic.span.file).toContain(
      "immutable_object_field_assignment.voyd"
    );
  });

  it("rejects passing immutable objects to mutable parameters", () => {
    const ast = loadAst("mutable_param_argument.voyd");

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught instanceof DiagnosticError).toBe(true);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    expect(caught.diagnostic.code).toBe("TY0004");
    expect(caught.diagnostic.span.file).toContain("mutable_param_argument.voyd");
  });

  it("allows mutating fields on mutable object bindings", () => {
    expect(() =>
      semanticsPipeline(loadAst("mutable_object_field_assignment.voyd"))
    ).not.toThrow();
  });
});
