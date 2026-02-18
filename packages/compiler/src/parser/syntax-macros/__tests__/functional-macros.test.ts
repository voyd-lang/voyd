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
});
