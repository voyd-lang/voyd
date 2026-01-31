import { describe, expect, it } from "vitest";
import { parse } from "../parser.js";

const toPlain = (code: string) =>
  JSON.parse(JSON.stringify(parse(code).toJSON()));

describe("qualified trait method syntax", () => {
  it("parses `x.Trait::method()` as a dot access whose member is `Trait::method()`", () => {
    const ast = toPlain(`
fn main()
  x.Bar::baz()
`);

    expect(ast).toEqual([
      "ast",
      ["fn", ["main"], ["block", [".", "x", ["::", "Bar", ["baz"]]]]],
    ]);
  });
});

