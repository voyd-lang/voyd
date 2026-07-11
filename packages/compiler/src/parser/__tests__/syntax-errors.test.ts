import { describe, expect, it } from "vitest";
import { ParserSyntaxError } from "../errors.js";
import { parse } from "../parser.js";
import {
  createModuleHeaderView,
  createSurfaceModuleView,
} from "../surface/index.js";

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
    ["use std::{ write as }", "use alias requires"],
    ["use std::{}", "grouped use path requires"],
    ["use std::{ write() }", "unsupported use path"],
  ])("reports malformed use path structure: %s", (source, message) => {
    expect(parseError(source, "/proj/src/use.voyd").message).toContain(message);
  });

  it.each([
    "use std::{ write as io_write }",
    "pub std::{ write as io_write }",
    "obj Value {\n  first: i32\n  second: i32\n}",
    "let value = { result: if true then: 1 else: 2 }",
    "let value = { result: match(source) Some: 1 }",
    "let value = { result: while false: void }",
    "let value = { result: for item in items: item }",
    "let value = { callback: x: i32 => x }",
    "fn use({ first: i32, second: i32 }) -> i32\n  first + second",
  ])("preserves valid brace and module syntax: %s", (source) => {
    expect(() => parse(source, "/proj/src/valid.voyd")).not.toThrow();
  });

  it("normalizes module headers and expanded declarations without cloning syntax", () => {
    const ast = parse(
      `use std::all
pub fn main() -> i32
  1
type Count = i32`,
      "/proj/src/pkg.voyd",
    );
    const header = createModuleHeaderView(ast);
    const surface = createSurfaceModuleView(ast);

    expect(header.items.map((item) => item.kind)).toEqual(["use"]);
    expect(surface.items.map((item) => item.kind)).toEqual([
      "use",
      "function",
      "type-alias",
    ]);
    expect(surface.issues).toEqual([]);
    const useItem = surface.items[0];
    expect(useItem?.kind).toBe("use");
    if (useItem?.kind !== "use")
      throw new Error("expected normalized use item");
    expect(useItem.form).toBe(ast.rest[0]);
  });

  it("reports malformed declarations as surface syntax issues", () => {
    const ast = parse("fn missing_body()", "/proj/src/invalid.voyd");
    const surface = createSurfaceModuleView(ast);

    expect(surface.items).toEqual([]);
    expect(surface.issues[0]?.message).toBe("fn missing body expression");
    expect(surface.issues[0]?.span.file).toBe("/proj/src/invalid.voyd");
  });

  it("validates lambda annotations in type context", () => {
    const valid = createSurfaceModuleView(
      parse(
        `fn main()
  let identity = (value: { field?: i32 }) => value`,
        "/proj/src/lambda-types.voyd",
      ),
    );
    expect(valid.issues).toEqual([]);

    const invalid = createSurfaceModuleView(
      parse(
        `fn main()
  let identity = (value: { field }) => value`,
        "/proj/src/lambda-types.voyd",
      ),
    );
    expect(invalid.issues[0]?.message).toBe(
      "object type fields must be labeled",
    );
  });

  it("validates effect handler annotations in type context", () => {
    const surface = createSurfaceModuleView(
      parse(
        `eff Async
  fn await(value: { field?: i32 }) -> i32

fn main(): Async -> i32
  try
    0
  Async::await(value: { field?: i32 }):
    0`,
        "/proj/src/handler-types.voyd",
      ),
    );

    expect(surface.issues).toEqual([]);
  });

  it("does not leak missing-comma candidates through AST attributes", () => {
    const ast = parse(
      "let value = { result: if true then: 1 else: 2 }",
      "/proj/src/valid.voyd",
    );

    expect(JSON.stringify(ast.toVerboseJSON())).not.toContain(
      "possibleMissingBraceEntryComma",
    );
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
