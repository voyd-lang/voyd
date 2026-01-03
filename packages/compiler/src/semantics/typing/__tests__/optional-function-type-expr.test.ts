import { describe, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";

describe("function type expressions", () => {
  it("preserves optional parameter flags", () => {
    const ast = loadAst("optional_function_type_expr_param.voyd");
    semanticsPipeline(ast);
  });
});
