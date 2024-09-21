import { parse } from "../../parser/parser.js";
import path from "node:path";
import { registerModules } from "../modules.js";
import { expandRegularMacros } from "../regular-macros.js";
import { regularMacrosVoydFile } from "./fixtures/regular-macros-voyd-file.js";
import { test } from "vitest";
import { List } from "../../syntax-objects/list.js";

test("regular macro expansion", async (t) => {
  const parserOutput = parse(regularMacrosVoydFile);
  const files = {
    std: new List([]),
    test: parserOutput,
  };
  const resolvedModules = registerModules({
    files,
    srcPath: path.dirname("test"),
    indexPath: "test.voyd",
  });
  const result = expandRegularMacros(resolvedModules);
  t.expect(result).toMatchSnapshot();
});
