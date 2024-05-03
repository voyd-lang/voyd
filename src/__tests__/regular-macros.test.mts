import { describe, it } from "node:test";
import { parse } from "../parser.mjs";
import { regularMacrosAst, regularMacrosVoidFile } from "./fixtures/index.mjs";
import assert from "node:assert";
import path from "node:path";
import { stdPath } from "../lib/parse-std.mjs";
import { resolveFileModules } from "../modules.mjs";
import { expandSyntaxMacrosOfFiles } from "../syntax-macros/index.mjs";
import { expandRegularMacros } from "../regular-macros.mjs";

describe("regular macro evaluation", () => {
  it("should evaluate macros of the example file", async () => {
    const parserOutput = parse(regularMacrosVoidFile);
    const files = expandSyntaxMacrosOfFiles({ test: parserOutput });
    const resolvedModules = resolveFileModules({
      files,
      srcPath: path.dirname("test"),
      stdPath: stdPath,
    });
    const result = expandRegularMacros(resolvedModules);
    assert.deepStrictEqual(
      JSON.parse(JSON.stringify(result)),
      regularMacrosAst
    );
  });
});
