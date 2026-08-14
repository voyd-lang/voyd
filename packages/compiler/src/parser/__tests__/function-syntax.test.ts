import { parse } from "../parser.js";
import { test } from "vitest";
import { isForm } from "../ast/index.js";
import {
  parseFunctionDecl,
  parseImplDecl,
  parseTraitDecl,
} from "../surface/declarations.js";

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
    ["->", ["view", [":", "value", ["Borrow", ["generics", "Box"]]]], "i32"],
    ["block", "1"],
  ]);
});

test("parses a nested generic Borrow inner type without special handling", (t) => {
  t.expect(toPlain("type X = Borrow<Option<i32>>")).toEqual([
    "ast",
    [
      "type",
      ["=", "X", ["Borrow", ["generics", ["Option", ["generics", "i32"]]]]],
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

test("parses isolated trait methods with an explicit empty effect row", (t) => {
  const ast = parse(`
/// Key behavior.
trait Key<K>
  /// Computes a hash.
  @isolated
  fn hash(self): () -> i32
`);
  const form = ast.rest.find((entry) => isForm(entry) && entry.calls("trait"));
  const declaration = isForm(form) ? parseTraitDecl(form) : null;

  t.expect(declaration?.methods[0]?.isolated).toBe(true);
});

test("rejects isolated trait methods without an explicit empty effect row", (t) => {
  const ast = parse(`
trait Key<K>
  @isolated
  fn hash(self) -> i32
`);
  const form = ast.rest.find((entry) => isForm(entry) && entry.calls("trait"));

  t.expect(() => (isForm(form) ? parseTraitDecl(form) : null)).toThrow(
    /explicit empty effect row/,
  );
});

test("rejects isolated on ordinary functions", (t) => {
  const ast = parse(`
@isolated
fn hash() : () -> i32
  1
`);
  const form = ast.rest.find((entry) => isForm(entry) && entry.calls("fn"));

  t.expect(() => (isForm(form) ? parseFunctionDecl(form) : null)).toThrow(
    /only annotate trait methods/,
  );
});

test("rejects arguments to isolated", (t) => {
  t.expect(() =>
    parse(`
trait Key
  @isolated(true)
  fn hash(self): () -> i32
`),
  ).toThrow(/does not accept arguments/);
});

test("parses finite result identity contracts on functions and trait methods", (t) => {
  const ast = parse(`
@result(detached)
fn detached(value: i32) -> i32
  value

trait Builder<T>
  @result(fresh)
  fn build(value: T) -> T
`);
  const fnForm = ast.rest.find((entry) => isForm(entry) && entry.calls("fn"));
  const traitForm = ast.rest.find(
    (entry) => isForm(entry) && entry.calls("trait"),
  );
  const fn = isForm(fnForm) ? parseFunctionDecl(fnForm) : null;
  const trait = isForm(traitForm) ? parseTraitDecl(traitForm) : null;

  t.expect(fn?.signature.resultIdentity).toEqual({ kind: "detached" });
  t.expect(trait?.methods[0]?.signature.resultIdentity).toEqual({
    kind: "fresh",
  });
});

test("parses a same-place return as the referenced mutable parameter type", (t) => {
  const ast = parse(`
fn update<T>(other: i32, ~target: T) -> ~target
  target
`);
  const form = ast.rest.find((entry) => isForm(entry) && entry.calls("fn"));
  const declaration = isForm(form) ? parseFunctionDecl(form) : null;

  t.expect(declaration?.signature.resultIdentity).toEqual({
    kind: "same-place",
    parameterIndex: 1,
  });
  t.expect(declaration?.signature.returnType?.toJSON()).toBe("T");
});

test("parses staged access contracts on functions and trait methods", (t) => {
  const ast = parse(`
@result(fresh)
@access(staged: out)
fn append(source: Box, ~out: Box) -> Box
  out

trait Append
  @access(staged: self)
  fn append(~self, source: Box): () -> void
`);
  const fnForm = ast.rest.find((entry) => isForm(entry) && entry.calls("fn"));
  const traitForm = ast.rest.find(
    (entry) => isForm(entry) && entry.calls("trait"),
  );
  const fn = isForm(fnForm) ? parseFunctionDecl(fnForm) : null;
  const trait = isForm(traitForm) ? parseTraitDecl(traitForm) : null;

  t.expect(fn?.signature.stagedAccess).toEqual({
    destinationParameterIndex: 1,
  });
  t.expect(fn?.signature.resultIdentity).toEqual({ kind: "fresh" });
  t.expect(trait?.methods[0]?.signature.stagedAccess).toEqual({
    destinationParameterIndex: 0,
  });
});

test("rejects invalid staged access contracts", (t) => {
  const parseDeclaration = (source: string) => {
    const ast = parse(source);
    const form = ast.rest.find((entry) => isForm(entry) && entry.calls("fn"));
    return isForm(form) ? parseFunctionDecl(form) : null;
  };
  t.expect(() =>
    parse(`@access(source: out)
fn bad(~out: i32) -> i32
  out`),
  ).toThrow(/labeled 'staged:' or 'builder:'/);
  t.expect(() =>
    parseDeclaration(`@access(staged: missing)
fn bad(~out: i32) -> i32
  out`),
  ).toThrow(/unknown parameter 'missing'/);
  t.expect(() =>
    parseDeclaration(`@access(staged: out)
fn bad(out: i32) -> i32
  out`),
  ).toThrow(/must be declared with '~'/);
});

test("parses builder access contracts and validates their destination", (t) => {
  const ast = parse(`
@access(builder: out)
fn write(source: Box, ~out: Box) -> void
  out.value = source.value
`);
  const form = ast.rest.find((entry) => isForm(entry) && entry.calls("fn"));
  const declaration = isForm(form) ? parseFunctionDecl(form) : null;
  t.expect(declaration?.signature.builderAccess).toEqual({
    destinationParameterIndex: 1,
  });
  t.expect(() =>
    parse(`@access(source: out)
fn bad(~out: i32) -> void
  void`),
  ).toThrow(/labeled 'staged:' or 'builder:'/);
  t.expect(() => {
    const invalid = parse(`@access(builder: out)
fn bad(out: i32) -> void
  void`);
    const invalidForm = invalid.rest.find(
      (entry) => isForm(entry) && entry.calls("fn"),
    );
    if (isForm(invalidForm)) parseFunctionDecl(invalidForm);
  }).toThrow(/must be declared with '~'/);
  const combined = parse(`@access(staged: out)
@access(builder: out)
fn combined(~out: i32) -> void
  void`);
  const combinedForm = combined.rest.find(
    (entry) => isForm(entry) && entry.calls("fn"),
  );
  const combinedDeclaration = isForm(combinedForm)
    ? parseFunctionDecl(combinedForm)
    : null;
  t.expect(combinedDeclaration?.signature.stagedAccess).toEqual({
    destinationParameterIndex: 0,
  });
  t.expect(combinedDeclaration?.signature.builderAccess).toEqual({
    destinationParameterIndex: 0,
  });
  t.expect(() =>
    parse(`@access(builder: out)
@access(builder: out)
fn duplicate(~out: i32) -> void
  void`),
  ).toThrow(/duplicate @access\(builder: \.\.\.\) attribute/);
});

test("rejects invalid or conflicting result identity contracts", (t) => {
  t.expect(() =>
    parse(`@result(stable)
fn bad() -> i32
  0`),
  ).toThrow(/unknown @result identity 'stable'/);
  t.expect(() =>
    parse(`@result(detached, fresh)
fn bad() -> i32
  0`),
  ).toThrow(/exactly one identity argument/);
  t.expect(() =>
    parse(`@result(detached)
let bad = 0`),
  ).toThrow(/must precede a function/);

  const parseDeclaration = (source: string) => {
    const ast = parse(source);
    const form = ast.rest.find((entry) => isForm(entry) && entry.calls("fn"));
    return isForm(form) ? parseFunctionDecl(form) : null;
  };
  t.expect(() =>
    parseDeclaration(`fn bad(value: i32) -> ~missing
  value`),
  ).toThrow(/unknown parameter 'missing'/);
  t.expect(() =>
    parseDeclaration(`fn bad(value: i32) -> ~value
  value`),
  ).toThrow(/must be declared with '~'/);
  t.expect(() =>
    parseDeclaration(`@result(fresh)
fn bad(~value: i32) -> ~value
  value`),
  ).toThrow(/cannot be combined/);
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
