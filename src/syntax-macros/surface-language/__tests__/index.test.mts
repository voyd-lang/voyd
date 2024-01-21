import { describe, it } from "node:test";
import assert from "assert";
import { desugarredAst } from "./fixtures/desugarred-ast.mjs";
import { parse } from "../../../parser.mjs";
import { voidFile } from "../../../__tests__/fixtures/void-file.mjs";
import { desugar } from "../../index.mjs";

describe("surface language macros", () => {
  it("should transform the surface language to the core language", async () => {
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
