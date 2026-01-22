import { describe, expect, it } from "vitest";

import type {
  HirBlockExpr,
  HirFunction,
  HirIfExpr,
  HirLetStatement,
} from "../../hir/index.js";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";
import { symbolRefKey } from "../symbol-ref-utils.js";

describe("nested generic instantiation", () => {
  it("isolates expression typing when a generic calls another generic", () => {
    const ast = loadAst("nested_generic_calls.voyd");
    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const root = symbolTable.rootScope;

    const combineSymbol = symbolTable.resolve("combine", root);
    expect(typeof combineSymbol).toBe("number");
    if (typeof combineSymbol !== "number") {
      return;
    }

    const combineFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === combineSymbol
    );
    expect(combineFn).toBeDefined();
    if (!combineFn) {
      return;
    }

    const combineInstantiations = typing.functionInstantiationInfo.get(
      symbolRefKey({ moduleId: semantics.moduleId, symbol: combineSymbol })
    );
    expect(combineInstantiations).toBeDefined();
    if (!combineInstantiations) {
      return;
    }

    const [instanceKey] = Array.from(combineInstantiations.keys());
    expect(instanceKey).toBeDefined();
    if (!instanceKey) {
      return;
    }

    const instanceExprTypes = typing.functionInstanceExprTypes.get(instanceKey);
    expect(instanceExprTypes).toBeDefined();
    if (!instanceExprTypes) {
      return;
    }

    const block = hir.expressions.get(combineFn.body) as HirBlockExpr;
    expect(block.exprKind).toBe("block");
    if (block.exprKind !== "block") {
      return;
    }

    const pickStmt = hir.statements.get(
      block.statements[0]!
    ) as HirLetStatement;
    expect(pickStmt.kind).toBe("let");
    if (pickStmt.kind !== "let") {
      return;
    }

    const boolType = typing.arena.internPrimitive("bool");
    expect(instanceExprTypes.get(pickStmt.initializer)).toBe(boolType);

    const ifExpr = hir.expressions.get(block.value!) as HirIfExpr;
    expect(ifExpr.exprKind).toBe("if");
    if (ifExpr.exprKind !== "if") {
      return;
    }

    const i32 = typing.arena.internPrimitive("i32");
    expect(instanceExprTypes.get(ifExpr.branches[0]!.value)).toBe(i32);
    expect(instanceExprTypes.get(ifExpr.defaultBranch!)).toBe(i32);
  });
});
