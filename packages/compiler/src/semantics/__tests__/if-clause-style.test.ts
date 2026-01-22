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

  it("handles clause-style if variants across multiple functions", () => {
    const result = semanticsPipeline(loadAst("if_clause_style_conditions.voyd"));
    const ifExprs = Array.from(result.hir.expressions.values()).filter(
      (expr) => expr.exprKind === "if"
    );

    expect(ifExprs).toHaveLength(4);
    const branchCounts = ifExprs
      .map((expr) => (expr.exprKind === "if" ? expr.branches.length : 0))
      .sort((a, b) => a - b);
    expect(branchCounts).toEqual([1, 2, 2, 2]);
    expect(
      ifExprs.every(
        (expr) => expr.exprKind === "if" && expr.defaultBranch !== undefined
      )
    ).toBe(true);
  });
});
