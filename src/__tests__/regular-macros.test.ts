import { describe, it } from "node:test";
import { parse } from "../parser.js";
import { regularMacrosAst, regularMacrosVoidFile } from "./fixtures/index.js";
import assert from "node:assert";
import path from "node:path";
import { stdPath } from "../lib/parse-std.js";
import { resolveFileModules } from "../modules.js";
import { expandSyntaxMacrosOfFiles } from "../syntax-macros/index.js";
import { expandRegularMacros } from "../regular-macros.js";

describe("regular macro evaluation", () => {
  it("should evaluate macros of the example file", async () => {
    const parserOutput = parse(regularMacrosVoidFile);
    const files = expandSyntaxMacrosOfFiles({ test: parserOutput });
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
