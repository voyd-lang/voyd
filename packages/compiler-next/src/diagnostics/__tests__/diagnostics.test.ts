import { describe, expect, it } from "vitest";
import {
  createDiagnostic,
  formatDiagnostic,
  normalizeSpan,
} from "../index.js";

describe("diagnostic utilities", () => {
  it("formats diagnostics with the inferred phase", () => {
    const diagnostic = createDiagnostic({
      code: "BD0001",
      message: "test diagnostic",
      span: { file: "file.voyd", start: 1, end: 3 },
    });

    const formatted = formatDiagnostic(diagnostic);
    expect(formatted).toContain("[binder]");
    expect(formatted).toContain("BD0001");
    expect(formatted.toLowerCase()).toContain("test diagnostic");
  });

  it("normalizes to the first available span", () => {
    const fallback = { file: "fallback", start: 0, end: 0 };
    const span = normalizeSpan(undefined, fallback);
    expect(span.file).toBe("fallback");
    expect(span.start).toBe(0);
  });
});
