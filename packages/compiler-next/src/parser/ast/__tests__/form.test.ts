import { describe, it, expect } from "vitest";
import { Form } from "../form.js";
import { Expr } from "../expr.js";
import { IdentifierAtom } from "../atom.js";
import { SourceLocation } from "../syntax.js";

describe("Form helpers", () => {
  it("dynamicLocation derives span from child locations", () => {
    const loc = (start: number, end: number) =>
      new SourceLocation({
        startIndex: start,
        endIndex: end,
        startLine: 1,
        endLine: 1,
        startColumn: start,
        endColumn: end,
        filePath: "test.vd",
      });

    const a = new IdentifierAtom({ value: "a", location: loc(0, 1) });
    const b = new IdentifierAtom({ value: "b", location: loc(2, 3) });
    const c = new IdentifierAtom({ value: "c", location: loc(4, 7) });

    const form = new Form([a, b, c]);

    expect(form.location).not.toBeUndefined();
    expect(form.location).not.toBe(a.location);
    expect(form.location?.startIndex).toBe(0);
    expect(form.location?.endIndex).toBe(7);
  });

  it("slice preserves derived locations", () => {
    const loc = (start: number, end: number) =>
      new SourceLocation({
        startIndex: start,
        endIndex: end,
        startLine: 1,
        endLine: 1,
        startColumn: start,
        endColumn: end,
        filePath: "test.vd",
      });

    const a = new IdentifierAtom({ value: "a", location: loc(0, 1) });
    const b = new IdentifierAtom({ value: "b", location: loc(2, 4) });
    const c = new IdentifierAtom({ value: "c", location: loc(5, 8) });

    const form = new Form([a, b, c]);

    const sliced = form.slice(1);

    expect(sliced.location).not.toBeUndefined();
    expect(sliced.location).not.toBe(form.location);
    expect(sliced.location?.startIndex).toBe(2);
    expect(sliced.location?.endIndex).toBe(8);
  });
});
