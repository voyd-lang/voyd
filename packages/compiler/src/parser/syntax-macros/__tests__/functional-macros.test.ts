import { describe, expect, test } from "vitest";
import { parse, parseBase } from "../../parser.js";
import { Form } from "../../ast/index.js";
import { readFileSync } from "fs";
import { resolve } from "path";
import { expandFunctionalMacros } from "../functional-macro-expander/index.js";

type Plain = (string | Plain)[];

const functionalMacrosVoydFile = readFileSync(
  resolve(import.meta.dirname, "__fixtures__", "functional_macros.voyd"),
  "utf-8"
);

const toPlain = (form: Form): Plain =>
  JSON.parse(JSON.stringify(form.toJSON()));

const containsDeep = (value: unknown, target: unknown): boolean => {
  if (Array.isArray(value) && Array.isArray(target)) {
    if (JSON.stringify(value) === JSON.stringify(target)) return true;
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsDeep(item, target));
  }

  if (value && typeof value === "object") {
    return Object.values(value).some((item) => containsDeep(item, target));
  }

  return false;
};

describe("functional macro expansion", () => {
  test("retains successful exports when later expansion fails", () => {
    const ast = parseBase(`\
pub macro keep(x)
  x
keep()
`);
    const errors: string[] = [];

    const { exports } = expandFunctionalMacros(ast, {
      strictMacroSignatures: true,
      onError: (error) => {
        errors.push(error.message);
      },
    });

    expect(errors).toHaveLength(1);
    expect(exports.map((entry) => entry.name.value)).toEqual(["keep"]);
  });

  test("does not throw for incomplete macro definitions while typing", () => {
    const code = `\
macro binaryen_gc_call
  syntax_template binaryen
`;
    expect(() => parse(code)).not.toThrow();
    expect(parse(code)).toBeInstanceOf(Form);
  });

  test("expands macro_let definitions into macro variables", () => {
    const ast = parse(functionalMacrosVoydFile);
    const plain = toPlain(ast);
    expect(
      containsDeep(plain, [
        "define-macro-variable",
        "extract_parameters",
        ["reserved-for-type"],
        ["is-mutable", "false"],
      ])
    ).toBe(true);
  });

  test("expands nested macro invocations", () => {
    const code = `\
macro binaryen_gc_call(func, args)
  syntax_template binaryen func: $func namespace: gc args: $args
macro bin_type_to_heap_type(type)
    binaryen_gc_call(modBinaryenTypeToHeapType, BnrType<type>)
bin_type_to_heap_type(FixedArray<Int>)
`;
    const ast = parse(code);
    const plain = toPlain(ast);
    const binaryenCall = plain.find(
      (item) => Array.isArray(item) && item.at(0) === "binaryen"
    );
    expect(binaryenCall).toEqual([
      "binaryen",
      "modBinaryenTypeToHeapType",
      "gc",
      ["BnrType", ["generics", ["FixedArray", ["generics", "Int"]]]],
    ]);
  });

  test("double tilde preserves labeled args", () => {
    const code = `\
macro binaryen_gc_call_1(func, args)
  syntax_template binaryen func: $func namespace: gc args: $args
macro wrap()
  syntax_template $$(binaryen_gc_call_1(modBinaryenTypeToHeapType, syntax_template arg))
wrap()
`;
    const ast = parse(code);
    expect(
      containsDeep(toPlain(ast), [
        "binaryen",
        [":", "func", "modBinaryenTypeToHeapType"],
        [":", "namespace", "gc"],
        [":", "args", "arg"],
      ])
    ).toBe(true);
  });

  test("calls recognizes internal identifier heads", () => {
    const code = `\
macro has_generics(type_expr)
  let maybe_generics = type_expr.get(1)
  if maybe_generics.calls(generics) then:
    1
  else:
    0
has_generics(Box<T>)
`;
    const ast = parse(code);
    const plain = toPlain(ast);
    expect(plain.at(-1)).toEqual("1");
  });

  test("with_location transfers source provenance to generated syntax", () => {
    const code = `\
macro relabel(generated, source)
  with_location(generated, source)
relabel(output, original)
`;
    const ast = parse(code);
    const output = ast.last;
    expect(output?.toJSON()).toBe("output");
    expect(output?.location?.startIndex).toBe(code.lastIndexOf("original"));
    expect(output?.location?.endIndex).toBe(
      code.lastIndexOf("original") + "original".length,
    );
  });

  test("supports clause-style if expressions in functional macros", () => {
    const code = `\
macro choose(n)
  if
    n == 1: 10
    n == 2: 20
    else: 30
choose(2)
`;
    const ast = parse(code);
    const plain = toPlain(ast);
    expect(plain.at(-1)).toEqual("20");
  });

  test("expands fn macro invocations", () => {
    const ast = parse(functionalMacrosVoydFile);
    const fibForm = toPlain(ast).at(-1);
    expect(fibForm).toEqual([
      "define_function",
      "fib",
      ["parameters", [":", "n", "i32"]],
      ["return_type", "i32"],
      [
        "block",
        [
          "block",
          ["define", "base", "1"],
          [
            "if",
            ["<=", "n", "base"],
            [":", "then", ["block", "n"]],
            [
              ":",
              "else",
              [
                "block",
                ["+", ["fib", ["-", "n", "1"]], ["fib", ["-", "n", "2"]]],
              ],
            ],
          ],
        ],
      ],
    ]);
  });

  test("splices top-level emit_many expansions into the ast root", () => {
    const code = `\
macro declare_pair()
  emit_many(\`(type (Left = i32)), \`(type (Right = i32)))
declare_pair()
`;
    const ast = parse(code);
    const plain = toPlain(ast);
    expect(plain).toContainEqual(["type", ["=", "Left", "i32"]]);
    expect(plain).toContainEqual(["type", ["=", "Right", "i32"]]);
  });

  test("treats empty emit_many lists as a no-op at top level", () => {
    const code = `\
macro emit_nothing()
  let declarations = \`().slice(1)
  emit_many(declarations)
emit_nothing()
type Keep = i32
`;
    const ast = parse(code);
    const plain = toPlain(ast);
    expect(plain).toContainEqual(["type", ["=", "Keep", "i32"]]);
    expect(plain).not.toContainEqual([]);
  });

  test("supports empty_list for explicit empty macro collections", () => {
    const code = `\
macro emit_nothing()
  let declarations = empty_list()
  emit_many(declarations)
emit_nothing()
type Keep = i32
`;
    const ast = parse(code);
    const plain = toPlain(ast);
    expect(plain).toContainEqual(["type", ["=", "Keep", "i32"]]);
    expect(plain).not.toContainEqual([]);
  });

  test("surfaces panic messages from functional macros", () => {
    const ast = parseBase(`\
macro fail()
  panic("boom")
fail()
`);
    const errors: string[] = [];

    expandFunctionalMacros(ast, {
      strictMacroSignatures: true,
      onError: (error) => {
        errors.push(error.message);
      },
    });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("boom");
  });

  test("does not implicitly splice top-level block expansions", () => {
    const code = `\
macro wrap_decl()
  \`(block (type (Only = i32)))
wrap_decl()
`;
    const ast = parse(code);
    expect(toPlain(ast)).toContainEqual([
      "block",
      ["type", ["=", "Only", "i32"]],
    ]);
  });

  test("supports pub-wrapped macro invocations", () => {
    const code = `\
macro declare_alias(name)
  \`(type ($name = i32))
pub declare_alias NumberLike
`;
    const ast = parse(code);
    const plain = toPlain(ast);
    expect(plain).toContainEqual(["pub", "type", ["=", "NumberLike", "i32"]]);
  });

  test("supports pub-wrapped value declarations from macros", () => {
    const code = `\
macro declare_value(name)
  \`(val $name { answer: i32 })
pub declare_value NumberLike
`;
    const ast = parse(code);
    const plain = toPlain(ast);
    expect(plain).toContainEqual([
      "pub",
      "val",
      "NumberLike",
      ["object_literal", [":", "answer", "i32"]],
    ]);
  });

  test("expands declaration attribute macros with structured arguments", () => {
    const code = `\
attribute macro companion(args, declaration)
  if args.length() == 1 then:
    emit_many(
      declaration,
      \`(fn generated() -> i32
        42)
    )
  else:
    panic("expected one attribute argument")

@companion(description: "generated helper")
fn original() -> i32
  1
`;

    const plain = toPlain(parse(code));
    expect(plain).toContainEqual([
      "fn",
      ["->", ["original"], "i32"],
      ["block", "1"],
    ]);
    expect(plain).toContainEqual([
      "fn",
      ["->", ["generated"], "i32"],
      ["block", "42"],
    ]);
  });

  test("applies stacked attribute macros from top to bottom", () => {
    const code = `\
attribute macro add_first(args, declaration)
  emit_many(
    declaration,
    \`(fn first_companion() -> i32
      1)
  )

attribute macro add_second(args, declaration)
  emit_many(
    declaration,
    \`(fn second_companion() -> i32
      2)
  )

@add_first
@add_second
fn original() -> i32
  0
`;

    const declarationNames = toPlain(parse(code)).flatMap((entry) =>
      Array.isArray(entry) && entry[0] === "fn"
        ? [((entry[1] as Plain)[1] as Plain)[0]]
        : [],
    );
    expect(declarationNames).toEqual([
      "original",
      "first_companion",
      "second_companion",
    ]);
  });

  test("bounds recursive attribute expansion", () => {
    const ast = parseBase(`\
attribute macro recurse(args, declaration)
  emit_many(\`(@ recurse), declaration)

@recurse
fn original() -> i32
  0
`);

    expect(() =>
      expandFunctionalMacros(ast, {
        strictMacroSignatures: true,
        maxAttributeExpansionDepth: 3,
      }),
    ).toThrow(/attribute macro expansion exceeded the depth limit of 3/i);
  });

  test("dispatches reserved compiler attributes after user expansion", () => {
    const ast = parse(`\
attribute macro preserve(args, declaration)
  declaration

@preserve
@effect(id: "voyd.example.time")
eff Time
  now
`);
    const effect = ast.rest.find(
      (entry) => entry instanceof Form && entry.calls("eff"),
    );

    expect(effect?.attributes?.effect).toEqual({ id: "voyd.example.time" });
  });

  test("rejects duplicate user-defined attributes", () => {
    expect(() =>
      parse(`\
attribute macro preserve(args, declaration)
  declaration

@preserve
@preserve
fn value() -> i32
  1
`),
    ).toThrow(/duplicate user-defined attribute '@preserve'/i);
  });

  test("rejects functional macros used as attributes", () => {
    expect(() =>
      parse(`\
macro ordinary(value)
  value

@ordinary
fn value() -> i32
  1
`),
    ).toThrow(/functional macro, not an attribute macro/i);
  });

  test("preserves unresolved attributes in context-free parser output", () => {
    const plain = toPlain(parse(`\
@imported_attribute
fn value() -> i32
  1
`));

    expect(plain).toContainEqual(["@", "imported_attribute"]);
  });

  test("applies attribute macros to visibility-modified methods", () => {
    const plain = toPlain(
      parse(`\
attribute macro preserve(args, declaration)
  declaration

obj Box {}

impl Box
  @preserve
  api fn answer(self) -> i32
    42
`),
    );

    expect(
      containsDeep(plain, [
        "api",
        "fn",
        ["->", ["answer", "self"], "i32"],
        ["block", "42"],
      ]),
    ).toBe(true);
  });

  test("applies attribute macros to enum declarations", () => {
    const plain = toPlain(
      parse(`\
attribute macro preserve(args, declaration)
  declaration

@preserve
enum Status
  Ready
`),
    );

    expect(plain).toContainEqual(["enum", "Status", ["block", "Ready"]]);
  });

  test("expands attributes emitted by ordinary functional macros", () => {
    const plain = toPlain(
      parse(`\
attribute macro preserve(args, declaration)
  declaration

macro declare_attributed()
  emit_many(
    \`(@ preserve),
    \`(fn generated() -> i32
      42)
  )

declare_attributed()
`),
    );

    expect(plain).toContainEqual([
      "fn",
      ["->", ["generated"], "i32"],
      ["block", "42"],
    ]);
    expect(plain).not.toContainEqual(["@", "preserve"]);
  });
});
