import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { DiagnosticError } from "../../../diagnostics/index.js";

describe("value position diagnostics", () => {
  it("reports type aliases used as values with a direct typing diagnostic", () => {
    const ast = loadAst("type_alias_used_as_value.voyd");

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

    expect(caught.diagnostic.code).toBe("TY0041");
    expect(caught.diagnostic.message).toMatch(/symbol 'Ver' is a type/i);
    expect(caught.diagnostic.code).not.toBe("TY9999");

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "type_alias_used_as_value.voyd"
    );
    const source = readFileSync(fixturePath, "utf8");
    const { start, end } = caught.diagnostic.span;
    expect(source.slice(start, end)).toBe("Ver");
  });

  it("reports field access on primitive receivers without TY9999 fallback", () => {
    const ast = loadAst("field_access_on_primitive.voyd");

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

    expect(caught.diagnostic.code).toBe("TY0033");
    expect(caught.diagnostic.message).toMatch(/unknown field 'x' on 'f64'/i);
    expect(caught.diagnostic.code).not.toBe("TY9999");

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "field_access_on_primitive.voyd"
    );
    const source = readFileSync(fixturePath, "utf8");
    const { start, end } = caught.diagnostic.span;
    expect(source.slice(start, end)).toContain("scalar.x");
  });
});
