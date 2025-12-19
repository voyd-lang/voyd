import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";

describe("nominal inheritance field validation", () => {
  it("requires derived objects to redeclare base fields", () => {
    const ast = loadAst("missing_base_fields.voyd");
    expect(() => semanticsPipeline(ast)).toThrow(/redeclare inherited field/i);
  });
});
