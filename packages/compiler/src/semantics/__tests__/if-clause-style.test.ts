import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../pipeline.js";
import { loadAst } from "./load-ast.js";

describe("if clause style", () => {
  it("parses and lowers clause-style if branches", () => {
    const result = semanticsPipeline(loadAst("if_clause_style.voyd"));

    const ifExpr = Array.from(result.hir.expressions.values()).find(
      (expr) => expr.exprKind === "if"
    );
    expect(ifExpr).toBeDefined();
    if (!ifExpr || ifExpr.exprKind !== "if") return;

    expect(ifExpr.branches).toHaveLength(2);
    expect(ifExpr.defaultBranch).toBeDefined();
  });
});

