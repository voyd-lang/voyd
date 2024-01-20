import { describe, it } from "node:test";
import { parse } from "../../parser.mjs";
import { voidFile } from "../../__tests__/fixtures/void-file.mjs";
import { desugar } from "../desugar.mjs";
import assert from "assert";
import { desugarredAst } from "./fixtures/desugarred-ast.mjs";

describe("desugar", () => {
  it("should desugar the example file", async () => {
    const parserOutput = parse(voidFile);

    const result = JSON.parse(
      JSON.stringify(
        desugar(parserOutput, {
          moduleId: "",
          path: "",
          srcPath: "",
          isRoot: false,
          workingDir: "",
          imports: [],
        })
      )
    );

    assert.deepStrictEqual(result, desugarredAst);
  });
});
