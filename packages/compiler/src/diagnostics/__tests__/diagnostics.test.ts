import { describe, expect, it } from "vitest";
import {
  diagnosticFromCode,
  formatDiagnostic,
  normalizeSpan,
} from "../index.js";

describe("diagnostic utilities", () => {
  it("formats diagnostics with the inferred phase", () => {
    const diagnostic = diagnosticFromCode({
      code: "BD0001",
      params: { kind: "module-unavailable", moduleId: "foo::bar" },
      span: { file: "file.voyd", start: 1, end: 3 },
    });

    const formatted = formatDiagnostic(diagnostic);
    expect(formatted).toContain("[binder]");
    expect(formatted).toContain("BD0001");
    expect(formatted.toLowerCase()).toContain("foo::bar");
  });

  it("normalizes to the first available span", () => {
    const fallback = { file: "fallback", start: 0, end: 0 };
    const span = normalizeSpan(undefined, fallback);
    expect(span.file).toBe("fallback");
    expect(span.start).toBe(0);
  });

  it("carries registry hints onto diagnostics", () => {
    const diagnostic = diagnosticFromCode({
      code: "TY0004",
      params: { kind: "argument-must-be-mutable", paramName: "param" },
      span: { file: "file.voyd", start: 0, end: 1 },
    });
    expect(diagnostic.hints).toBeDefined();
    expect(diagnostic.hints?.[0]?.message).toContain("~");
  });

  it("guides ambiguous overloads toward explicit annotations", () => {
    const diagnostic = diagnosticFromCode({
      code: "TY0007",
      params: { kind: "ambiguous-overload", name: "pick" },
      span: { file: "file.voyd", start: 0, end: 1 },
    });
    expect(diagnostic.hints?.[0]?.message).toContain("type arguments");
    expect(diagnostic.hints?.[0]?.message).toContain("backtracking");
  });

  it("formats overload mismatch details with inferred types and candidates", () => {
    const diagnostic = diagnosticFromCode({
      code: "TY0008",
      params: {
        kind: "no-overload",
        name: "add",
        inferredArguments: ["i32", "bool"],
        candidates: [
          {
            signature: "add(a: i32, b: i32) -> i32",
            reason: "type incompatibility at argument 2: expected i32, got bool",
          },
        ],
      },
      span: { file: "file.voyd", start: 0, end: 1 },
    });

    expect(diagnostic.message).toContain("no overload of add matches argument types");
    expect(diagnostic.message).toContain("inferred argument types: (i32, bool)");
    expect(diagnostic.message).toContain("candidates:");
    expect(diagnostic.message).toContain("type incompatibility");
  });
});
