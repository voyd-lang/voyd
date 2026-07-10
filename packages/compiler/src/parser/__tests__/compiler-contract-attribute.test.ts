import { test } from "vitest";
import type { CompilerContractAttribute } from "../attributes.js";
import { isForm, parse } from "../index.js";

const parseFunction = (text: string) => {
  const ast = parse(text);
  const fn = ast.rest[0];
  if (!isForm(fn)) {
    throw new Error("expected a function declaration");
  }
  return fn;
};

test("@compiler_contract attaches an ordinary function contract id", (t) => {
  const fn =
    parseFunction(`@compiler_contract(id: "voyd.std.boundary.msgpack.make-null")
fn make_null() -> i32
  0`);

  t.expect(
    fn.attributes?.compilerContract as CompilerContractAttribute | undefined,
  ).toEqual({ id: "voyd.std.boundary.msgpack.make-null" });
  t.expect(fn.attributes?.intrinsic).toBeUndefined();
});

test("@compiler_contract composes with @intrinsic", (t) => {
  const fn =
    parseFunction(`@compiler_contract(id: "voyd.std.boundary.msgpack.string-new")
@intrinsic(name: "__string_new", uses_signature: true)
fn new_string(bytes: i32) -> i32
  bytes`);

  t.expect(fn.attributes?.compilerContract).toEqual({
    id: "voyd.std.boundary.msgpack.string-new",
  });
  t.expect(fn.attributes?.intrinsic).toEqual({
    name: "__string_new",
    usesSignature: true,
  });
});

test("@compiler_contract requires exactly one labeled string id", (t) => {
  t.expect(() =>
    parse(`@compiler_contract("voyd.std.boundary.msgpack.make-null")
fn bad() -> i32
  0`),
  ).toThrow(/must be labeled with ':'/);

  t.expect(() =>
    parse(`@compiler_contract(id: 1)
fn bad() -> i32
  0`),
  ).toThrow(/id must be a string/);

  t.expect(() =>
    parse(`@compiler_contract(id: "a", id: "b")
fn bad() -> i32
  0`),
  ).toThrow(/duplicate @compiler_contract 'id:'/);

  t.expect(() =>
    parse(`@compiler_contract(name: "a")
fn bad() -> i32
  0`),
  ).toThrow(/unknown @compiler_contract argument 'name'/);
});

test("@compiler_contract rejects duplicate attributes and wrong targets", (t) => {
  t.expect(() =>
    parse(`@compiler_contract(id: "voyd.std.boundary.msgpack.make-null")
@compiler_contract(id: "voyd.std.boundary.msgpack.make-bool")
fn bad() -> i32
  0`),
  ).toThrow(/duplicate @compiler_contract attribute/);

  t.expect(() =>
    parse(`@compiler_contract(id: "voyd.std.boundary.msgpack.make-null")
let bad = 0`),
  ).toThrow(/must precede a function/);
});
