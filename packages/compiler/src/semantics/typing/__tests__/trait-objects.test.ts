import { describe, expect, it } from "vitest";
import type { HirBlockExpr, HirCallExpr, HirFunction } from "../../hir/nodes.js";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";

describe("trait objects", () => {
  it("accepts trait-typed parameters and dispatches trait method calls", () => {
    const ast = loadAst("trait_object_dispatch.voyd");
    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const root = symbolTable.rootScope;

    const doDouble = symbolTable.resolve("do_double", root);
    const mainSymbol = symbolTable.resolve("main", root);
    const traitSymbol = symbolTable.resolve("Doubleable", root);
    expect(doDouble).toBeDefined();
    expect(mainSymbol).toBeDefined();
    expect(traitSymbol).toBeDefined();

    const signature = typeof doDouble === "number"
      ? typing.functions.getSignature(doDouble)
      : undefined;
    expect(signature?.parameters[0]).toBeDefined();
    if (signature?.parameters[0]) {
      const paramDesc = typing.arena.get(signature.parameters[0].type);
      expect(paramDesc.kind).toBe("trait");
    }

    const mainCall = Array.from(hir.expressions.values()).find(
      (expr): expr is HirCallExpr => {
        if (expr.exprKind !== "call") return false;
        const calleeExpr = hir.expressions.get(expr.callee);
        return (
          calleeExpr?.exprKind === "identifier" &&
          typeof doDouble === "number" &&
          calleeExpr.symbol === doDouble
        );
      }
    );
    expect(mainCall).toBeDefined();
    if (mainCall) {
      const callType = typing.table.getExprType(mainCall.id);
      const desc = callType ? typing.arena.get(callType) : undefined;
      expect(desc?.kind).toBe("primitive");
      if (desc?.kind === "primitive") {
        expect(desc.name).toBe("i32");
      }
    }

    const impls =
      typeof traitSymbol === "number"
        ? typing.traitImplsByTrait.get(traitSymbol)
        : undefined;
    expect(impls?.length).toBeGreaterThanOrEqual(1);

    const doDoubleFn = Array.from(hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" && item.symbol === doDouble
    );
    expect(doDoubleFn).toBeDefined();
    const doDoubleBody = doDoubleFn?.body;
    const doDoubleExpr = doDoubleBody
      ? hir.expressions.get(doDoubleBody)
      : undefined;
    const blockValue =
      doDoubleExpr?.exprKind === "block" ? doDoubleExpr.value : undefined;
    const doDoubleCall =
      doDoubleExpr?.exprKind === "call"
        ? doDoubleExpr
        : typeof blockValue === "number"
          ? hir.expressions.get(blockValue)
          : undefined;
    expect(doDoubleCall?.exprKind).toBe("call");
    if (doDoubleCall) {
      expect(typing.callTraitDispatches.has(doDoubleCall.id)).toBe(true);
    }
  });
});
