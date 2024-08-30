import { describe, it } from "node:test";
import assert from "node:assert";
import { parseChars } from "../parse-chars.js";
import { voidFile } from "./fixtures/parse-text-void-file.js";
import { rawParserAST } from "./fixtures/raw-parser-ast.js";

describe("parse file", () => {
  it("should parse the example file into a raw ast", async () => {
    const parserOutput = parseChars(voidFile);
    const result = JSON.parse(JSON.stringify(parserOutput.toJSON()));
    assert.deepStrictEqual(result, rawParserAST);
  });
});
