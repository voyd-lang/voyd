import { describe, it } from "node:test";
import { parse } from "../parser.mjs";
import { rawParserAST, voidFile } from "./fixtures/index.mjs";
import assert from "node:assert";

describe("parser", () => {
  it("should parse the example file", async () => {
    const parserOutput = parse(voidFile);
    const result = JSON.parse(JSON.stringify(parserOutput.toJSON()));
    assert.deepStrictEqual(result, rawParserAST);
  });
});
