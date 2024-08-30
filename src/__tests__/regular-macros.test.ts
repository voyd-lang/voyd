import { describe, it } from "node:test";
import { parse } from "../parser/parser.js";
import { regularMacrosAst, regularMacrosVoidFile } from "./fixtures/index.js";
import assert from "node:assert";
import path from "node:path";
import { resolveFileModules } from "../modules.js";
import { expandRegularMacros } from "../regular-macros.js";
import { stdPath } from "../parser/api/parse-std.js";

describe("regular macro evaluation", () => {
  it("should evaluate macros of the example file", async () => {
    const parserOutput = parse(regularMacrosVoidFile);
    const files = { test: parserOutput };
    const resolvedModules = resolveFileModules({
      files,
      srcPath: path.dirname("test"),
      indexPath: "test.void",
      stdPath: stdPath,
    });
    const result = expandRegularMacros(resolvedModules);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(result)),
      regularMacrosAst
    );
  });
});
