import { describe, it } from "vitest";
import { expect } from "vitest";
import { CharStream } from "../char-stream.js";
import { parseChars } from "../parse-chars.js";
import { functionalNotation } from "./functional-notation.js";
import { interpretWhitespace } from "./interpret-whitespace.js";
import { primary } from "./primary.js";

const expand = (code: string) => {
  const parsed = parseChars(new CharStream(code, "test"));
  const functional = functionalNotation(parsed);
  const whitespace = interpretWhitespace(functional);
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
    const ast = expand("pub fn main() { foo.bar(x) }");
    expect(ast).toEqual([
      "ast",
      ["pub", "fn", ["main"], ["object_literal", ["bar", "foo", "x"]]],
    ]);
  });

  it("parses method calls with generics", () => {
    const ast = expand("pub fn main() foo.bar<Option>(x)");
    expect(ast).toEqual([
      "ast",
      ["pub", "fn", ["main"], ["bar", ["generics", "Option"], "foo", "x"]],
    ]);
  });

  it("expands dot-call closure sugar", () => {
    const ast = expand(`
      pub fn main()
        foo.(x => x + 1)
    `);
    expect(ast).toEqual([
      "ast",
      [
        "pub",
        "fn",
        ["main"],
        ["block", ["call-closure", ["=>", "x", ["+", "x", "1"]], "foo"]],
      ],
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
});
