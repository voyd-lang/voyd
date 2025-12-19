import { test } from "vitest";
import type { IntrinsicAttribute } from "../attributes.js";
import { isForm, parse } from "../index.js";

const parseFunction = (text: string) => {
  const ast = parse(text);
  const fn = ast.rest[0];
  if (!isForm(fn)) {
    throw new Error("expected a function declaration");
  }
  return fn;
};

test("@intrinsic attaches metadata with arguments", (t) => {
  const fn = parseFunction(`@intrinsic(name: "__array_get", uses_signature: true)
fn get(arr: FixedArray<i32>, idx: i32) -> i32
  __array_get(arr, idx)`);

  t.expect(fn.attributes?.intrinsic as IntrinsicAttribute | undefined).toEqual({
    name: "__array_get",
    usesSignature: true,
  });
});

test("@intrinsic defaults name and uses_signature", (t) => {
  const fn = parseFunction(`@intrinsic
fn len(arr: FixedArray<i32>) -> i32
  __array_len(arr)`);

  t.expect(fn.attributes?.intrinsic as IntrinsicAttribute | undefined).toEqual({
    name: "len",
    usesSignature: false,
  });
});

test("@intrinsic rejects unknown labels", (t) => {
  t.expect(() =>
    parse(`@intrinsic(extra: 1)
fn bad() -> i32
  0`)
  ).toThrow(/unknown @intrinsic argument/);
});

test("@intrinsic enforces value types", (t) => {
  t.expect(() =>
    parse(`@intrinsic(uses_signature: "__array_get")
fn bad() -> i32
  0`)
  ).toThrow(/uses_signature must be a boolean/);
});

test("@intrinsic requires ':' separators", (t) => {
  t.expect(() =>
    parse(`@intrinsic(name = "__array_get")
fn bad() -> i32
  0`)
  ).toThrow(/must be labeled with ':'/);
});
