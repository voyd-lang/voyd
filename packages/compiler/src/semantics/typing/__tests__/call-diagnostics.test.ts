import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { DiagnosticError } from "../../../diagnostics/index.js";

describe("call diagnostics", () => {
  it("reports diagnostics for calling non-function values", () => {
    const ast = loadAst("non_function_call.voyd");

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

    expect(caught.diagnostic.code).toBe("TY0005");
    expect(caught.diagnostic.message).toMatch(
      /cannot call a non-function value/i
    );

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "non_function_call.voyd"
    );
    const source = readFileSync(fixturePath, "utf8");
    const { start, end } = caught.diagnostic.span;
    expect(source.slice(start, end)).toBe("x");
  });

  it("reports diagnostics for calling a missing function", () => {
    const ast = loadAst("missing_function_call.voyd");

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

    expect(caught.diagnostic.code).toBe("TY0006");
    expect(caught.diagnostic.message).toMatch(/function 'hi' is not defined/i);

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "missing_function_call.voyd"
    );
    const source = readFileSync(fixturePath, "utf8");
    const { start, end } = caught.diagnostic.span;
    expect(source.slice(start, end)).toBe("hi");
  });

  it("reports actionable diagnostics when string literal lowering helper is missing", () => {
    const ast = loadAst("string_literal_missing_new_string_import.voyd");

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

    expect(caught.diagnostic.code).toBe("TY0006");
    expect(caught.diagnostic.message).toMatch(
      /import std::string::fns::new_string/i
    );
    expect(caught.diagnostic.code).not.toBe("TY9999");
    expect(caught.diagnostic.span.file).toBe(
      "string_literal_missing_new_string_import.voyd"
    );

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "string_literal_missing_new_string_import.voyd"
    );
    const source = readFileSync(fixturePath, "utf8");
    const { start, end } = caught.diagnostic.span;
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain("1.2.3");
  });

  it("reports diagnostics for calling a missing method", () => {
    const ast = loadAst("missing_method_call.voyd");

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

    expect(caught.diagnostic.code).toBe("TY0022");
    expect(caught.diagnostic.message).toMatch(
      /method 'nope' is not defined on Box/i
    );

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "missing_method_call.voyd"
    );
    const source = readFileSync(fixturePath, "utf8");
    const { start, end } = caught.diagnostic.span;
    expect(source.slice(start, end)).toBe("b.nope");
  });

  it("reports diagnostics with spans for call argument type mismatches", () => {
    const ast = loadAst("call_arg_type_mismatch.voyd");

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
    expect(caught.diagnostic.message).toMatch(
      /type mismatch: expected 'i32', received 'bool'/
    );

    const fixturePath = resolve(
      import.meta.dirname,
      "..",
      "..",
      "__tests__",
      "__fixtures__",
      "call_arg_type_mismatch.voyd"
    );
    const source = readFileSync(fixturePath, "utf8");
    const { start, end } = caught.diagnostic.span;
    expect(source.slice(start, end)).toBe("true");
  });
});
