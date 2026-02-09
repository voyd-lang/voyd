import { describe, expect, it } from "vitest";
import type { HirMethodCallExpr } from "../../hir/nodes.js";
import { semanticsPipeline } from "../../pipeline.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";
import { loadAst } from "../../__tests__/load-ast.js";

describe("method call resolution", () => {
  it("falls back to free functions when a same-named method does not match", () => {
    const semantics = semanticsPipeline(
      loadAst("method_call_method_name_collision.voyd"),
    );
    expect(semantics.diagnostics).toHaveLength(0);

    const methodCall = Array.from(semantics.hir.expressions.values()).find(
      (expr): expr is HirMethodCallExpr =>
        expr.exprKind === "method-call" && expr.method === "reduce",
    );
    expect(methodCall).toBeDefined();
    if (!methodCall) return;

    const symbolTable = getSymbolTable(semantics);
    const rootScope = symbolTable.rootScope;

    const mainSymbol = symbolTable.resolve("main", rootScope);
    const reduceSymbol = symbolTable.resolve("reduce", rootScope);
    expect(typeof mainSymbol).toBe("number");
    expect(typeof reduceSymbol).toBe("number");
    if (typeof mainSymbol !== "number" || typeof reduceSymbol !== "number") {
      return;
    }

    const instanceKey = `${mainSymbol}<>`;
    const target = semantics.typing.callTargets.get(methodCall.id)?.get(instanceKey);
    expect(target?.symbol).toBe(reduceSymbol);
  });
});
