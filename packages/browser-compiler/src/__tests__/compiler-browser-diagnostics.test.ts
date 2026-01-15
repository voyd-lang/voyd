import { describe, expect, it } from "vitest";
import { DiagnosticError } from "@voyd/compiler/diagnostics/index.js";
import { compile } from "../compiler-browser.js";

describe("browser compiler diagnostics", () => {
  it("preserves structured codegen diagnostics when throwing", async () => {
    const source = `
pub fn identity<T>(value: T) -> T
  value

pub fn main()
  0
`;

    let caught: unknown;
    try {
      await compile(source);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DiagnosticError);
    if (!(caught instanceof DiagnosticError)) {
      throw new Error("Expected DiagnosticError");
    }

    expect(caught.diagnostic.code).toBe("CG0003");
    expect(caught.diagnostic.span.file).toBe("src::index");
    expect(caught.diagnostic.span.end).toBeGreaterThan(caught.diagnostic.span.start);
  });
});

