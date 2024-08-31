import { parse } from "../../parser/parser.js";
import path from "node:path";
import { registerModules } from "../modules.js";
import { expandRegularMacros } from "../regular-macros.js";
import { regularMacrosVoidFile } from "./fixtures/regular-macros-void-file.js";
import { test } from "vitest";

test("regular macro expansion", async (t) => {
  const parserOutput = parse(regularMacrosVoidFile);
  const files = { test: parserOutput };
  const resolvedModules = registerModules({
    files,
    srcPath: path.dirname("test"),
    indexPath: "test.void",
  });
  const result = expandRegularMacros(resolvedModules);
  t.expect(result).toMatchSnapshot();
});
