import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { DiagnosticError } from "../../../diagnostics/index.js";

describe("branch condition diagnostics", () => {
  it("points if-condition mismatches at the condition expression span", () => {
    const ast = loadAst("if_condition_type_mismatch_span.voyd");

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

    expect(caught.diagnostic.code).toBe("TY0027");

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "if_condition_type_mismatch_span.voyd",
    );
    const source = readFileSync(fixturePath, "utf8");
    const { start, end } = caught.diagnostic.span;
    expect(source.slice(start, end)).toContain("hit(1.0");
  });

  it("points while-condition mismatches at the condition expression span", () => {
    const ast = loadAst("while_condition_type_mismatch_span.voyd");

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

    expect(caught.diagnostic.code).toBe("TY0027");

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "while_condition_type_mismatch_span.voyd",
    );
    const source = readFileSync(fixturePath, "utf8");
    const { start, end } = caught.diagnostic.span;
    expect(source.slice(start, end)).toBe("1.0");
  });
});
