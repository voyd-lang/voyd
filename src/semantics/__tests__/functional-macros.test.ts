import { parse } from "../../parser/parser.js";
import path from "node:path";
import { registerModules } from "../modules.js";
import { expandFunctionalMacros } from "../functional-macros.js";
import { functionalMacrosVoydFile } from "./fixtures/functional-macros-voyd-file.js";
import { test } from "vitest";
import { List } from "../../syntax-objects/list.js";

test("functional macro expansion", async (t) => {
  const parserOutput = parse(functionalMacrosVoydFile);
  const files = {
    std: new List([]),
    test: parserOutput,
  };
  const resolvedModules = registerModules({
    files,
    srcPath: path.dirname("test"),
    indexPath: "test.voyd",
  });
  const result = expandFunctionalMacros(resolvedModules);
  t.expect(result).toMatchSnapshot();
});

test("nested functional macro expansion", async (t) => {
  const code = `\
macro binaryen_gc_call(func, args)\n\
  quote binaryen func: $func namespace: gc args: $args\n\
macro bin_type_to_heap_type(type)\n\
  binaryen_gc_call(modBinaryenTypeToHeapType, BnrType<type>)\n\
bin_type_to_heap_type(FixedArray<Int>)\n`;
  const parserOutput = parse(code);
  const files = {
    std: new List([]),
    test: parserOutput,
  };
  const resolvedModules = registerModules({
    files,
    srcPath: path.dirname("test"),
    indexPath: "test.voyd",
  });
  const result = expandFunctionalMacros(resolvedModules) as any;
  const testModule = (result as any).value.at(-1) as any;
  const last = testModule.value.at(-1) as List;
  const rendered = JSON.parse(JSON.stringify(last));
  t.expect(rendered).toEqual([
    "binaryen",
    "modBinaryenTypeToHeapType",
    "gc",
    ["BnrType", ["generics", ["FixedArray", ["generics", "Int"]]]],
  ]);
});

test("$@ preserves labeled args", async (t) => {
  const code = `\
macro binaryen_gc_call_1(func, args)\n\
  quote binaryen func: $func namespace: gc args: $args\n\
macro wrap()\n\
  quote $@(binaryen_gc_call_1(modBinaryenTypeToHeapType, quote arg))\n\
wrap()\n`;
  const parserOutput = parse(code);
  const files = {
    std: new List([]),
    test: parserOutput,
  };
  const resolvedModules = registerModules({
    files,
    srcPath: path.dirname("test"),
    indexPath: "test.voyd",
  });
  const result = expandFunctionalMacros(resolvedModules) as any;
  const testModule = (result as any).value.at(-1) as any;
  const last = testModule.value.at(-1) as List;
  const rendered = JSON.parse(JSON.stringify(last));
  t.expect(rendered).toEqual([
    "binaryen",
    [":", "func", "modBinaryenTypeToHeapType"],
    [":", "namespace", "gc"],
    [":", "args", ["arg"]],
  ]);
});
