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

  it("reports alias pattern mismatches without falling back to TY9999", () => {
    const ast = loadAst("match_alias_pattern_mismatch.voyd");

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
    expect(diagnostic.message).toMatch(/pattern 'C'/i);
    expect(diagnostic.code).not.toBe("TY9999");

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "match_alias_pattern_mismatch.voyd"
    );
    const source = readFileSync(fixturePath, "utf8");
    expect(source.slice(diagnostic.span.start, diagnostic.span.end)).toBe("C");
  });

  it("reports redundant alias match arms as warnings", () => {
    const ast = loadAst("match_union_alias_infer_args.voyd");
    const result = semanticsPipeline(ast);
    const diagnostic = result.diagnostics.find((entry) => entry.code === "TY0039");

    expect(diagnostic).toBeDefined();
    expect(diagnostic?.severity).toBe("warning");
    expect(diagnostic?.phase).toBe("typing");
    expect(diagnostic?.message).toMatch(/pattern 'C'/i);

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "match_union_alias_infer_args.voyd"
    );
    const source = readFileSync(fixturePath, "utf8");
    if (diagnostic) {
      expect(source.slice(diagnostic.span.start, diagnostic.span.end)).toBe("C");
    }
  });
});
