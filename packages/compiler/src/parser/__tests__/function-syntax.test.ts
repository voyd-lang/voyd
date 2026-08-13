import { parse } from "../parser.js";
import { test } from "vitest";
import { isForm } from "../ast/index.js";
import { parseImplDecl, parseTraitDecl } from "../surface/declarations.js";

const toPlain = (code: string) =>
  JSON.parse(JSON.stringify(parse(code).toJSON()));

test("parses fn with = separator", (t) => {
  t.expect(toPlain("fn fib() = test()")).toEqual([
    "ast",
    ["fn", ["=", ["fib"], ["test"]]],
  ]);
});

test("parses fn with return type and =", (t) => {
  t.expect(toPlain("fn fib() -> i32 = test()")).toEqual([
    "ast",
    ["fn", ["=", ["->", ["fib"], "i32"], ["test"]]],
  ]);
});

test("parses Borrow with the standard generic type syntax", (t) => {
  const code = `
fn view(value: Borrow<Box>) -> i32
  1`;

  const ast = toPlain(code);
  t.expect(ast).toContainEqual([
    "fn",
    [
      "->",
      ["view", [":", "value", ["Borrow", ["generics", "Box"]]]],
      "i32",
    ],
    ["block", "1"],
  ]);
});

test("parses a nested generic Borrow inner type without special handling", (t) => {
  t.expect(toPlain("type X = Borrow<Option<i32>>")).toEqual([
    "ast",
    [
      "type",
      [
        "=",
        "X",
        [
          "Borrow",
          ["generics", ["Option", ["generics", "i32"]]],
        ],
      ],
    ],
  ]);
});

test("does not parse lowercase borrow as a prefix operator", (t) => {
  t.expect(toPlain("type X = borrow Box")).toEqual([
    "ast",
    ["type", ["=", "X", ["borrow", "Box"]]],
  ]);
});

test("keeps borrow available as an identifier outside type-prefix use", (t) => {
  const code = `
fn identity(borrow: i32) -> i32
  borrow

fn invoke(borrow: fn() -> i32) -> i32
  borrow()

fn pass(borrow: i32) -> i32
  identity(borrow)

fn add(left: i32, right: i32) -> i32
  left + right

fn pass_two(borrow: i32, other: i32) -> i32
  add(borrow, other)`;

  const ast = toPlain(code);
  t.expect(ast).toContainEqual([
    "fn",
    ["->", ["identity", [":", "borrow", "i32"]], "i32"],
    ["block", "borrow"],
  ]);
  t.expect(ast).toContainEqual([
    "fn",
    ["->", ["invoke", [":", "borrow", ["->", ["fn"], "i32"]]], "i32"],
    ["block", ["borrow"]],
  ]);
  t.expect(ast).toContainEqual([
    "fn",
    ["->", ["pass", [":", "borrow", "i32"]], "i32"],
    ["block", ["identity", "borrow"]],
  ]);
  t.expect(ast).toContainEqual([
    "fn",
    ["->", ["pass_two", [":", "borrow", "i32"], [":", "other", "i32"]], "i32"],
    ["block", ["add", "borrow", "other"]],
  ]);
});

test("keeps postfix and generic uses of the borrow identifier intact", (t) => {
  const ast = toPlain(`
fn f(borrow: Array<i32>) -> i32
  borrow[0]

fn borrow<T>(x: T) -> T
  x`);

  t.expect(ast).toContainEqual([
    "fn",
    ["->", ["f", [":", "borrow", ["Array", ["generics", "i32"]]]], "i32"],
    ["block", ["subscript", "borrow", "0"]],
  ]);
  t.expect(ast).toContainEqual([
    "fn",
    ["->", ["borrow", ["generics", "T"], [":", "x", "T"]], "T"],
    ["block", "x"],
  ]);
});

test("parses fn with effect annotation and =", (t) => {
  t.expect(toPlain("fn fib(): effect -> i32 = test()")).toEqual([
    "ast",
    ["fn", ["=", [":", ["fib"], ["->", "effect", "i32"]], ["test"]]],
  ]);
});

test("parses explicit open callback effect rows in parameter types", (t) => {
  const code = `
fn run(cb: fn() : (open) -> i32)
  cb()`;

  t.expect(toPlain(code)).toEqual([
    "ast",
    [
      "fn",
      ["run", [":", [":", "cb", ["fn"]], ["->", "open", "i32"]]],
      ["block", ["cb"]],
    ],
  ]);
});

test("parses explicit open rows on function declarations", (t) => {
  const code = `
fn call() : (open) -> i32
  1`;

  t.expect(toPlain(code)).toEqual([
    "ast",
    ["fn", [":", ["call"], ["->", "open", "i32"]], ["block", "1"]],
  ]);
});

test("parses explicit open callback effect rows in local let annotations", (t) => {
  const code = `
fn main()
  let cb: fn() : (open) -> i32 = () => 1
  cb()`;

  t.expect(toPlain(code)).toEqual([
    "ast",
    [
      "fn",
      ["main"],
      [
        "block",
        [
          "let",
          [
            "=",
            [":", [":", "cb", ["fn"]], ["->", "open", "i32"]],
            ["=>", [], "1"],
          ],
        ],
        ["cb"],
      ],
    ],
  ]);
});

test("parses explicit open rows on = declarations", (t) => {
  t.expect(toPlain("fn run() : (open) -> i32 = 1")).toEqual([
    "ast",
    ["fn", ["=", [":", ["run"], ["->", "open", "i32"]], "1"]],
  ]);
});

test("parses explicit open rows on trait default methods", (t) => {
  const code = `
trait T
  fn run() : (open) -> i32 = 1`;

  t.expect(toPlain(code)).toEqual([
    "ast",
    [
      "trait",
      "T",
      ["block", ["fn", ["=", [":", ["run"], ["->", "open", "i32"]], "1"]]],
    ],
  ]);
});

test("rejects removed trait region declarations", (t) => {
  const ast = parse(`
trait Invalid<T>
  region cursor
`);
  const declaration = ast.rest.find(
    (entry) => isForm(entry) && entry.calls("trait"),
  );
  t.expect(isForm(declaration)).toBe(true);
  t.expect(() =>
    isForm(declaration) ? parseTraitDecl(declaration) : null,
  ).toThrow(/only function declarations|must start with 'fn'/);
});

test("rejects removed borrow_contract attributes", (t) => {
  const ast = parse(`
trait PureView
  @borrow_contract()
  fn count(self) -> i32
`);
  const declaration = ast.rest.find(
    (entry) => isForm(entry) && entry.calls("trait"),
  );
  t.expect(isForm(declaration)).toBe(true);
  t.expect(() =>
    isForm(declaration) ? parseTraitDecl(declaration) : null,
  ).toThrow();
});

test("rejects removed impl region mappings and deref contract places", (t) => {
  const ast = parse(`
impl Box
  region source = deref(self.items)
`);
  const declaration = ast.rest.find(
    (entry) => isForm(entry) && entry.calls("impl"),
  );
  t.expect(isForm(declaration)).toBe(true);
  t.expect(() =>
    isForm(declaration) ? parseImplDecl(declaration) : null,
  ).toThrow(/only function declarations/);
});

test("rejects removed disjoint declarations", (t) => {
  const ast = parse(`
trait Invalid<T>
  disjoint left, right
`);
  const declaration = ast.rest.find(
    (entry) => isForm(entry) && entry.calls("trait"),
  );
  t.expect(isForm(declaration)).toBe(true);
  t.expect(() =>
    isForm(declaration) ? parseTraitDecl(declaration) : null,
  ).toThrow(/only function declarations|must start with 'fn'/);
});

test("ignores inline line comments in function bodies", (t) => {
  t.expect(toPlain("fn fib() = // comment\n  test()")).toEqual([
    "ast",
    ["fn", ["=", ["fib"], ["test"]]],
  ]);
});

test("parses union return types without parentheses", (t) => {
  const code = `
fn describe(x: NumBox) -> Some<i32> | Some<f64>
  x.match()
    Some<f64>: 30
    Some<i32>: x.v + 1`;

  t.expect(toPlain(code)).toEqual([
    "ast",
    [
      "fn",
      [
        "->",
        ["describe", [":", "x", "NumBox"]],
        ["|", ["Some", ["generics", "i32"]], ["Some", ["generics", "f64"]]],
      ],
      [
        "block",
        [
          ".",
          "x",
          [
            "match",
            [":", ["Some", ["generics", "f64"]], "30"],
            [":", ["Some", ["generics", "i32"]], ["+", [".", "x", "v"], "1"]],
          ],
        ],
      ],
    ],
  ]);
});

test("parses union return types with multiple pipes without stealing the block", (t) => {
  const code = `
fn choose(x: i32) -> None | Some | Other
  foo(x)`;

  t.expect(toPlain(code)).toEqual([
    "ast",
    [
      "fn",
      [
        "->",
        ["choose", [":", "x", "i32"]],
        ["|", "None", ["|", "Some", "Other"]],
      ],
      ["block", ["foo", "x"]],
    ],
  ]);
});

test("parses module-qualified return types", (t) => {
  const code = `
fn build() -> my_module::MyType
  my_module::MyType { value: 1 }`;

  t.expect(toPlain(code)).toEqual([
    "ast",
    [
      "fn",
      ["->", ["build"], ["::", "my_module", "MyType"]],
      [
        "block",
        [
          ["::", "my_module", "MyType"],
          ["object_literal", [":", "value", "1"]],
        ],
      ],
    ],
  ]);
});
