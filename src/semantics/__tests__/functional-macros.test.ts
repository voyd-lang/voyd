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

test("quote2 expands macros within macros", async (t) => {
  const source = `
pub macro \`() quote2 $@body

pub macro binaryen_gc_call(func, args, return_type)
  \` binaryen func: $func namespace: gc args: $args return_type: $return_type

pub macro bin_type_to_heap_type(type)
  binaryen_gc_call(modBinaryenTypeToHeapType, \` [BnrType<($type)>])

bin_type_to_heap_type(FixedArray<Int>)
`;
  const parserOutput = parse(source);
  const files = { std: new List([]), test: parserOutput };
  const resolvedModules = registerModules({
    files,
    srcPath: path.dirname("test"),
    indexPath: "test.voyd",
  });
  const result = expandFunctionalMacros(resolvedModules);
  t.expect(result).toMatchSnapshot();
});
