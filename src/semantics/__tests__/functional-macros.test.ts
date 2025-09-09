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
