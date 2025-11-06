import { describe, expect, test } from "vitest";
import { parse } from "../../parser.js";
import { Form, Expr } from "../../ast/index.js";
import { functionalMacrosVoydFile } from "../../../../semantics/__tests__/fixtures/functional-macros-voyd-file.js";

const toPlain = (form: Form) => JSON.parse(JSON.stringify(form.toJSON()));

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

describe.skip("functional macro expansion", () => {
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
    console.log(JSON.stringify(toPlain(ast), null, 2));
    expect(
      containsDeep(toPlain(ast), [
        "binaryen",
        "modBinaryenTypeToHeapType",
        "gc",
        ["BnrType", ["generics", ["FixedArray", ["generics", "Int"]]]],
      ])
    ).toBe(true);
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
        [":", "args", ["arg"]],
      ])
    ).toBe(true);
  });
});
