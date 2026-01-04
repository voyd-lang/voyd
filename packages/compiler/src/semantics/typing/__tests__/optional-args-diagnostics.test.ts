import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { DiagnosticError } from "../../../diagnostics/index.js";

describe("optional argument diagnostics", () => {
  it("reports extra arguments after skipping an optional parameter", () => {
    const ast = loadAst("optional_call_leftover_arg.voyd");

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

    expect(caught.diagnostic.code).toBe("TY0021");
    expect(caught.diagnostic.message).toMatch(/extra argument/i);

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "optional_call_leftover_arg.voyd"
    );
    const source = readFileSync(fixturePath, "utf8");
    const { start, end } = caught.diagnostic.span;
    expect(source.slice(start, end)).toContain("sum(1");
  });

  it("requires parameters to be marked with ? to allow omission", () => {
    const ast = loadAst("optional_call_missing_required.voyd");

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

    expect(caught.diagnostic.code).toBe("TY0021");
    expect(caught.diagnostic.message).toMatch(/missing required call argument/i);
    expect(caught.diagnostic.message).toMatch(/opt/i);
  });
});

