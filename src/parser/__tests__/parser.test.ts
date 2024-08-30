import { describe, it } from "node:test";
import assert from "assert";
import { desugarredAst } from "./fixtures/desugarred-ast.js";
import { parse } from "../parser.js";
import { voidFile } from "./fixtures/void-file.js";

describe("Parse", () => {
  it("parse a file into a syntax expanded ast", async () => {
    const result = JSON.parse(JSON.stringify(parse(voidFile)));
    assert.deepStrictEqual(result, desugarredAst);
  });
});
