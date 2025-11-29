import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { DiagnosticError } from "../../../diagnostics/index.js";

describe("match diagnostics", () => {
  it("reports helpful errors for non-matching patterns", () => {
    const ast = loadAst("invalid_match_pattern.voyd");

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

    const diagnostic = caught.diagnostic;
    expect(diagnostic.phase).toBe("typing");
    expect(diagnostic.code).toBe("TY0002");
    expect(diagnostic.message).toMatch(/pattern 'Hi'/i);

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "invalid_match_pattern.voyd"
    );
    const source = readFileSync(fixturePath, "utf8");
    expect(source.slice(diagnostic.span.start, diagnostic.span.end)).toBe("Hi");

    const related = diagnostic.related?.[0];
    expect(related?.severity).toBe("note");
    expect(related?.message).toMatch(/discriminant expression/i);
  });
});
