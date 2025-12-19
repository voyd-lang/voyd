import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Diagnostic } from "@voyd/compiler/diagnostics/index";
import { describe, expect, it } from "vitest";
import { formatCliDiagnostic } from "../diagnostics.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturePath = resolve(__dirname, "fixtures/sample.voyd");
const fixtureSource = readFileSync(fixturePath, "utf8");

const findFixtureDiagnostic = (): Diagnostic => {
  const start = fixtureSource.indexOf('"Hi"');
  if (start < 0) {
    throw new Error("fixture missing span target");
  }
  const lastNewline = fixtureSource.lastIndexOf("\n", start - 1);
  const column = start - lastNewline;

  return {
    code: "TY0002",
    message: "pattern 'Hi' does not match discriminant",
    severity: "error",
    span: { file: fixturePath, start, end: start + `"Hi"`.length },
    phase: "typing",
    // keep tests resilient to unrelated properties
    related: [],
  };
};

describe("formatCliDiagnostic", () => {
  it("renders the location and source snippet", () => {
    const diagnostic = findFixtureDiagnostic();
    const formatted = formatCliDiagnostic(diagnostic, { color: false });

    const line = fixtureSource.slice(0, diagnostic.span.start).split("\n").length;
    const column =
      diagnostic.span.start -
      (fixtureSource.lastIndexOf("\n", diagnostic.span.start - 1) ?? 0);

    expect(formatted).toContain(
      `${diagnostic.span.file}:${line}:${column}`
    );
    expect(formatted).toContain(` |     "Hi" => "h"`);
    expect(formatted).toContain("^");
    expect(formatted).toContain(
      "TY0002: pattern 'Hi' does not match discriminant"
    );
  });

  it("falls back gracefully when the source file is missing", () => {
    const missing = resolve(__dirname, "does-not-exist.voyd");
    const diagnostic: Diagnostic = {
      code: "BD0001",
      message: "missing module",
      severity: "error",
      span: { file: missing, start: 3, end: 7 },
    };

    const formatted = formatCliDiagnostic(diagnostic, { color: false });

    expect(formatted).toContain(`${missing}:3-7`);
    expect(formatted).not.toContain(" | ");
  });
});
