import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { DiagnosticError } from "../../../diagnostics/index.js";

describe("default parameter diagnostics", () => {
  it("requires explicit types for defaulted parameters in generic functions", () => {
    const ast = loadAst("default_param_generic_missing_type.voyd");

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

    expect(caught.diagnostic.code).toBe("TY0043");
    expect(caught.diagnostic.message).toMatch(/default parameter b/i);
    expect(caught.diagnostic.message).toMatch(/generic function pick/i);

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "default_param_generic_missing_type.voyd",
    );
    const source = readFileSync(fixturePath, "utf8");
    const { start, end } = caught.diagnostic.span;
    expect(source.slice(start, end)).toContain("b");
  });

  it("rejects forward parameter references in default expressions", () => {
    const ast = loadAst("default_param_forward_reference.voyd");

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

    expect(caught.diagnostic.code).toBe("TY0044");
    expect(caught.diagnostic.message).toMatch(/default parameter a/i);
    expect(caught.diagnostic.message).toMatch(/parameter b/i);
  });
});
