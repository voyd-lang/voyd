import { describe, expect, it } from "vitest";
import { ParserSyntaxError } from "../errors.js";
import { parse } from "../parser.js";

describe("parser syntax errors", () => {
  it.each([
    "let value = { first: source second: 2 }",
    "let value = { first: make(1) second: 2 }",
    "let value = { first: 1 + 2 second: 3 }",
    "obj Value { first: i32 second: i32 }",
    "type Value = { first: i32 second: i32 }",
  ])("reports missing commas in brace fields: %s", (source) => {
    const error = parseError(source, "/proj/src/fields.voyd");

    expect(error.message).toBe("Expected ',' before 'second' in braces");
    expect(error.location?.filePath).toBe("/proj/src/fields.voyd");
  });

  it("reports colon module access syntax in use declarations", () => {
    const error = parseError("use std:all", "/proj/src/use.voyd");

    expect(error.message).toBe(
      "Invalid module access syntax; use '::' between module path segments",
    );
    expect(error.location?.filePath).toBe("/proj/src/use.voyd");
    expect(error.location?.startLine).toBe(1);
  });

  it.each([
    "pub std:all",
    "use std::{ write: io_write }",
    "use std::{ foo:bar:baz }",
  ])("reports colon module access syntax in exports: %s", (source) => {
    const error = parseError(source, "/proj/src/export.voyd");

    expect(error.message).toBe(
      "Invalid module access syntax; use '::' between module path segments",
    );
  });

  it.each([
    "use std::{ write as io_write }",
    "pub std::{ write as io_write }",
    "obj Value {\n  first: i32\n  second: i32\n}",
    "let value = { result: if true then: 1 else: 2 }",
    "let value = { result: match(source) Some: 1 }",
    "fn use({ first: i32, second: i32 }) -> i32\n  first + second",
  ])("preserves valid brace and module syntax: %s", (source) => {
    expect(() => parse(source, "/proj/src/valid.voyd")).not.toThrow();
  });
});

const parseError = (source: string, filePath: string): ParserSyntaxError => {
  try {
    parse(source, filePath);
  } catch (error) {
    expect(error).toBeInstanceOf(ParserSyntaxError);
    if (error instanceof ParserSyntaxError) return error;
  }

  throw new Error("expected parsing to fail");
};
