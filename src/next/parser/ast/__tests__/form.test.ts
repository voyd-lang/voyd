import { describe, it, expect } from "vitest";
import { Form } from "../form.js";
import { Expr } from "../expr.js";
import { IdentifierAtom } from "../atom.js";
import { SourceLocation } from "../syntax.js";

const groupToJSON = (groups: Expr[][]) =>
  groups.map((group) => group.map((expr) => expr.toJSON()));

describe("Form helpers", () => {
  it("elementsOf returns empty array for undefined", () => {
    expect(Form.elementsOf(undefined)).toEqual([]);
  });

  it("elementsOf returns element list for a form", () => {
    const form = new Form(["a", "b"]);
    expect(Form.elementsOf(form).map((expr) => expr.toJSON())).toEqual([
      "a",
      "b",
    ]);
  });

  it("splitOnDelimiter splits on commas by default", () => {
    const form = new Form(["a", ",", "b", ",", "c"]);
    const groups = form.splitOnDelimiter();
    expect(groupToJSON(groups)).toEqual([["a"], ["b"], ["c"]]);
  });

  it("splitOnDelimiter ignores trailing delimiter", () => {
    const form = new Form(["a", ",", "b", ","]);
    const groups = form.splitOnDelimiter();
    expect(groupToJSON(groups)).toEqual([["a"], ["b"]]);
  });

  it("callArgs returns the second element when it is a form", () => {
    const args = new Form(["x"]);
    const call = new Form(["foo", args, "rest"]);
    expect(call.callArgs()).toBe(args);
  });

  it("callArgs returns undefined when second element is not a form", () => {
    const call = new Form(["foo", "bar"]);
    expect(call.callArgs()).toBeUndefined();
  });

  it("updateCallArgs returns original form when transform returns existing args", () => {
    const args = new Form(["x"]);
    const call = new Form(["foo", args]);
    const result = call.updateCallArgs((current) => current);
    expect(result).toBe(call);
  });

  it("updateCallArgs inserts new args when none exist", () => {
    const call = new Form(["foo"]);
    const updated = call.updateCallArgs(() => new Form(["x"]));
    expect(Form.elementsOf(updated.callArgs()).map((expr) => expr.toJSON())).toEqual(["x"]);
    expect(call.callArgs()).toBeUndefined();
  });

  it("updateCallArgs preserves existing elements after update", () => {
    const args = new Form(["x"]);
    const call = new Form(["foo", args, "tail"]);
    const updated = call.updateCallArgs((current) =>
      new Form([...current.toArray(), "y"])
    );

    expect(updated).not.toBe(call);
    expect(updated.toArray()[2]?.toJSON()).toEqual("tail");
    expect(
      Form.elementsOf(updated.callArgs()).map((expr) => expr.toJSON())
    ).toEqual(["x", "y"]);
  });

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

    const form = new Form({
      elements: [a, b, c],
      dynamicLocation: true,
    });

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

    const form = new Form({
      elements: [a, b, c],
      dynamicLocation: true,
    });

    const sliced = form.slice(1);

    expect(sliced.location).not.toBeUndefined();
    expect(sliced.location).not.toBe(form.location);
    expect(sliced.location?.startIndex).toBe(2);
    expect(sliced.location?.endIndex).toBe(8);
  });
});
