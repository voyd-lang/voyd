import { describe, it } from "vitest";
import { expect } from "vitest";
import { CharStream } from "../../char-stream.js";
import { read } from "../../reader.js";
import { interpretWhitespace } from "../interpret-whitespace.js";
import { primary } from "../primary.js";

const expand = (code: string) => {
  const parsed = read(new CharStream(code, "test"));
  const whitespace = interpretWhitespace(parsed);
  const result = primary(whitespace);
  return JSON.parse(JSON.stringify(result));
};

describe("primary syntax macro", () => {
  it("respects operator precedence", () => {
    const ast = expand("pub fn main() 1 + 2 * 3");
    expect(ast).toEqual([
      "ast",
      ["pub", "fn", ["main"], ["+", "1", ["*", "2", "3"]]],
    ]);
  });

  it("parses method calls with arguments", () => {
    const ast = expand("pub fn main() foo.bar(x)");
    expect(ast).toEqual([
      "ast",
      ["pub", "fn", ["main"], [".", "foo", ["bar", "x"]]],
    ]);
  });

  it("binds prefix operators after member access", () => {
    const ast = expand("pub fn main() not self.ok");
    expect(ast).toEqual([
      "ast",
      ["pub", "fn", ["main"], ["not", [".", "self", "ok"]]],
    ]);
  });

  it("parses tuple destructuring", () => {
    const ast = expand("let (x, y) = (1, 2)");
    expect(ast).toEqual([
      "ast",
      ["let", ["=", ["tuple", "x", "y"], ["tuple", "1", "2"]]],
    ]);
  });

  it("parses method calls with generics", () => {
    const ast = expand("pub fn main() foo.bar<Option>(x)");
    expect(ast).toEqual([
      "ast",
      [
        "pub",
        "fn",
        ["main"],
        [".", "foo", ["bar", ["generics", "Option"], "x"]],
      ],
    ]);
  });

  it("expands dot-call closure sugar", () => {
    const ast = expand(`
      pub fn main()
        foo.(x => x + 1)
    `);
    expect(ast).toEqual([
      "ast",
      ["pub", "fn", ["main"], ["block", [".", "foo", ["=>", "x", ["+", "x", "1"]]]]],
    ]);
  });

  it("removes tuple wrapper from lambda parameters", () => {
    const ast = expand("pub fn main() (a, b) => a + b ");
    expect(ast).toEqual([
      "ast",
      ["pub", "fn", ["main"], ["=>", ["a", "b"], ["+", "a", "b"]]],
    ]);
  });

  it("groups expressions to the right of infix operators", () => {
    const code = `
      pub fn main()
        {
          a: hello there,
          b: 2
        }
    `;

    const ast = expand(code);
    expect(ast).toEqual([
      "ast",
      [
        "pub",
        "fn",
        ["main"],
        [
          "block",
          ["object_literal", [":", "a", ["hello", "there"]], [":", "b", "2"]],
        ],
      ],
    ]);
  });

  it("attaches indented suites to functional calls", () => {
    const expected = expand(`
      match pet
        Dog { noses }: noses + 2
        Cat { lives: l }: l
    `);

    const actual = expand(`
      match(pet)
        Dog { noses }: noses + 2
        Cat { lives: l }: l
    `);

    expect(actual).toEqual(expected);
  });
});
