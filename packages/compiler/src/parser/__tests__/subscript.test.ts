import { describe, expect, it } from "vitest";
import { isForm, parse } from "../index.js";

const parseFirstExpression = (source: string) => {
  const ast = parse(source);
  const expr = ast.at(1);
  expect(expr).toBeDefined();
  return expr!;
};

const parseSubscriptIndex = (source: string) => {
  const expr = parseFirstExpression(source);
  expect(isForm(expr)).toBe(true);
  if (!isForm(expr) || !expr.callsInternal("subscript")) {
    throw new Error("expected subscript form");
  }
  const index = expr.at(2);
  expect(index).toBeDefined();
  return index!;
};

const isEmptyForm = (value: unknown): boolean =>
  isForm(value) && value.length === 0;

describe("subscript syntax", () => {
  it("parses adjacent brackets as subscript", () => {
    const expr = parseFirstExpression("foo[1]");
    expect(isForm(expr)).toBe(true);
    if (!isForm(expr)) return;

    expect(expr.callsInternal("subscript")).toBe(true);
    expect(JSON.parse(JSON.stringify(expr.toJSON()))).toEqual([
      "subscript",
      "foo",
      "1",
    ]);
  });

  it("keeps spaced brackets as array-literal call argument", () => {
    const expr = parseFirstExpression("foo [1]");
    expect(isForm(expr)).toBe(true);
    if (!isForm(expr)) return;
    expect(expr.calls("foo")).toBe(true);
    expect(JSON.parse(JSON.stringify(expr.toJSON()))).toEqual([
      "foo",
      [
        "new_array_unchecked",
        [":", "from", ["fixed_array_literal", "1"]],
      ],
    ]);
  });

  it("parses subscript assignment target", () => {
    const expr = parseFirstExpression("foo[1] = 2");
    expect(isForm(expr)).toBe(true);
    if (!isForm(expr)) return;
    expect(expr.calls("=")).toBe(true);

    const target = expr.at(1);
    expect(isForm(target)).toBe(true);
    if (!isForm(target)) return;
    expect(target.callsInternal("subscript")).toBe(true);
  });
});

describe("range operators", () => {
  it("parses binary ranges", () => {
    const exclusive = parseSubscriptIndex("foo[2..8]");
    const inclusive = parseSubscriptIndex("foo[2..=8]");
    const aliasExclusive = parseSubscriptIndex("foo[2..<8]");

    expect(isForm(exclusive) && exclusive.calls("..")).toBe(true);
    expect(isForm(inclusive) && inclusive.calls("..=")).toBe(true);
    expect(isForm(aliasExclusive) && aliasExclusive.calls("..<")).toBe(true);
  });

  it("parses unbounded range variants", () => {
    const left = parseSubscriptIndex("foo[..8]");
    const leftInclusive = parseSubscriptIndex("foo[..=8]");
    const right = parseSubscriptIndex("foo[2..]");
    const full = parseSubscriptIndex("foo[..]");

    expect(isForm(left) && left.calls("..")).toBe(true);
    expect(isForm(leftInclusive) && leftInclusive.calls("..=")).toBe(true);
    expect(isForm(right) && right.calls("..")).toBe(true);
    expect(isForm(full) && full.calls("..")).toBe(true);

    expect(isForm(right) && isEmptyForm(right.at(2))).toBe(true);
    expect(isForm(full) && isEmptyForm(full.at(1))).toBe(true);
  });
});
