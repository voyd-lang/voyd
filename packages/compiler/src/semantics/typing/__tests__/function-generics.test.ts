import { describe, expect, it } from "vitest";

import type { HirCallExpr, HirIdentifierExpr } from "../../hir/index.js";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";

describe("generic functions", () => {
  it("instantiates generic functions with explicit type arguments", () => {
    const ast = loadAst("function_generics.voyd");
    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const root = symbolTable.rootScope;

    const addSymbol = symbolTable.resolve("add", root);
    expect(typeof addSymbol).toBe("number");
    if (typeof addSymbol !== "number") {
      return;
    }

    const addScheme = typing.table.getSymbolScheme(addSymbol);
    expect(addScheme).toBeDefined();
    if (!addScheme) {
      return;
    }

    const i32 = typing.arena.internPrimitive("i32");
    const addType = typing.arena.instantiate(addScheme, [i32]);
    const addDesc = typing.arena.get(addType);
    expect(addDesc.kind).toBe("function");
    if (addDesc.kind !== "function") {
      return;
    }
    expect(addDesc.parameters.map((param) => param.type)).toEqual([i32, i32]);
    expect(addDesc.returnType).toBe(i32);

    const addCall = Array.from(hir.expressions.values()).find(
      (expr): expr is HirCallExpr => {
        if (expr.exprKind !== "call") {
          return false;
        }
        const callee = hir.expressions.get(expr.callee);
        return (
          callee?.exprKind === "identifier" &&
          (callee as HirIdentifierExpr).symbol === addSymbol
        );
      }
    );

    expect(addCall).toBeDefined();
    if (!addCall) {
      return;
    }
    expect(typing.table.getExprType(addCall.id)).toBe(i32);
  });
});
