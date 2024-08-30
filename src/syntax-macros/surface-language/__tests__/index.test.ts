import { describe, it } from "node:test";
import assert from "assert";
import { desugarredAst } from "./fixtures/desugarred-ast.js";
import { parse } from "../../../parser/parser.js";
import { voidFile } from "./fixtures/void-file.js";
import { surfaceLanguage } from "../index.js";

describe("surface language macros", () => {
  it("should transform the surface language to the core language", async () => {
    const parserOutput = parse(voidFile);
    const result = JSON.parse(JSON.stringify(surfaceLanguage(parserOutput)));
    assert.deepStrictEqual(result, desugarredAst);
  });
});
