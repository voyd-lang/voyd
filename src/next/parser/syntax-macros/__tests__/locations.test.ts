import { describe, it, expect } from "vitest";
import { functionalNotation } from "../functional-notation.js";
import { interpretWhitespace } from "../interpret-whitespace.js";
import { Form } from "../../ast/form.js";
import { IdentifierAtom, InternalIdentifierAtom } from "../../ast/atom.js";
import { SourceLocation } from "../../ast/syntax.js";

const makeLocation = (start: number, end: number) =>
  new SourceLocation({
    startIndex: start,
    endIndex: end,
    startLine: 1,
    endLine: 1,
    startColumn: start,
    endColumn: end,
    filePath: "test.vd",
  });

describe("syntax macro locations", () => {
  it("functionalNotation clones form locations", () => {
    const foo = new IdentifierAtom({
      value: "foo",
      location: makeLocation(0, 3),
    });
    const arg = new IdentifierAtom({
      value: "x",
      location: makeLocation(4, 5),
    });
    const args = new Form([arg]);
    const paren = new Form({
      elements: [new InternalIdentifierAtom({ value: "paren" }), args],
      location: makeLocation(3, 6),
    });
    const formLocation = makeLocation(0, 6);
    const original = new Form({
      elements: [foo, paren],
      location: formLocation,
    });

    const result = functionalNotation(original);

    expect(result.location).not.toBe(formLocation);
    expect(result.location?.toJSON()).toEqual(formLocation.toJSON());
    expect(original.location?.toJSON()).toEqual(formLocation.toJSON());
  });

  it("interpretWhitespace produces fresh location objects", () => {
    const identLocation = makeLocation(0, 5);
    const ident = new IdentifierAtom({
      value: "foo",
      location: identLocation,
    });
    const originalLocation = makeLocation(0, 5);
    const original = new Form({
      elements: [ident],
      location: originalLocation,
    });

    const result = interpretWhitespace(original);

    expect(result.location).not.toBe(originalLocation);
    expect(result.location).not.toBe(identLocation);
    expect(result.location?.toJSON()).toEqual(identLocation.toJSON());
    expect(original.location?.toJSON()).toEqual(originalLocation.toJSON());
  });
});
