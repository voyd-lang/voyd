import { describe, expect, test } from "vitest";
import { parse } from "../../parser.js";
import { Form } from "../../ast/index.js";
import { functionalMacrosVoydFile } from "@voyd/compiler/semantics/__tests__/fixtures/functional-macros-voyd-file.js";

type Plain = (string | Plain)[];

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
  syntax_template binaryen func: ~func namespace: gc args: ~args
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
  syntax_template binaryen func: ~func namespace: gc args: ~args
macro wrap()
  syntax_template ~~(binaryen_gc_call_1(modBinaryenTypeToHeapType, syntax_template arg))
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
});
