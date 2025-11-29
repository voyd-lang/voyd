import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { DiagnosticError } from "../../diagnostics.js";

describe("immutable bindings", () => {
  it("rejects reassigning a let binding and reports a precise diagnostic", () => {
    const ast = loadAst("immutable_let_assignment.voyd");

    let caught: unknown;
    try {
      semanticsPipeline(ast);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DiagnosticError);
    if (!(caught instanceof DiagnosticError)) {
      return;
    }

    const diagnostic = caught.diagnostic;
    expect(diagnostic.code).toBe("TY0001");
    expect(diagnostic.message).toMatch(/immutable binding 'a'/i);
    expect(diagnostic.span.file).toContain("immutable_let_assignment.voyd");

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "immutable_let_assignment.voyd"
    );
    const source = readFileSync(fixturePath, "utf8");
    expect(source.slice(diagnostic.span.start, diagnostic.span.end).trim()).toBe(
      "a"
    );

    const declaration = diagnostic.related?.[0];
    expect(declaration?.severity).toBe("note");
    expect(declaration?.message).toMatch(/declared here/i);
    if (declaration) {
      expect(declaration.span.file).toContain("immutable_let_assignment.voyd");
      expect(declaration.span.start).toBeLessThan(diagnostic.span.start);
    }
  });
});
