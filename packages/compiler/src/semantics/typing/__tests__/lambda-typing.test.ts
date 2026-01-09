import { describe, expect, it } from "vitest";

import type { HirLambdaExpr } from "../../hir/index.js";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";
import type { SymbolTable } from "../../binder/index.js";

const lambdaByParam = (
  hir: ReturnType<typeof semanticsPipeline>["hir"],
  symbolTable: SymbolTable,
  name: string
): HirLambdaExpr | undefined =>
  Array.from(hir.expressions.values()).find(
    (expr): expr is HirLambdaExpr =>
      expr.exprKind === "lambda" &&
      expr.parameters.some(
        (param) => symbolTable.getSymbol(param.symbol).name === name
      )
  );

describe("lambda typing", () => {
  it("infers parameter and return types from context", () => {
    const semantics = semanticsPipeline(loadAst("lambda_typing.voyd"));
    const { hir, typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const i32 = typing.arena.internPrimitive("i32");

    const doubled = lambdaByParam(hir, symbolTable, "x");
    expect(doubled).toBeDefined();
    if (!doubled) return;
    const doubledTypeId = typing.table.getExprType(doubled.id);
    expect(doubledTypeId).toBeDefined();
    if (doubledTypeId === undefined) return;
    const doubledType = typing.arena.get(doubledTypeId);
    expect(doubledType.kind).toBe("function");
    if (doubledType.kind !== "function") return;
    expect(doubledType.parameters.map((param) => param.type)).toEqual([i32]);
    expect(doubledType.returnType).toBe(i32);

    const incrementer = lambdaByParam(hir, symbolTable, "value");
    expect(incrementer).toBeDefined();
    if (!incrementer) return;
    const incrementerTypeId = typing.table.getExprType(incrementer.id);
    expect(incrementerTypeId).toBeDefined();
    if (incrementerTypeId === undefined) return;
    const incrementerType = typing.arena.get(incrementerTypeId);
    expect(incrementerType.kind).toBe("function");
    if (incrementerType.kind !== "function") return;
    expect(incrementerType.parameters.map((param) => param.type)).toEqual([
      i32,
    ]);
    expect(incrementerType.returnType).toBe(i32);

    const trimmed = lambdaByParam(hir, symbolTable, "n");
    expect(trimmed).toBeDefined();
    if (!trimmed) return;
    const trimmedTypeId = typing.table.getExprType(trimmed.id);
    expect(trimmedTypeId).toBeDefined();
    if (trimmedTypeId === undefined) return;
    const trimmedType = typing.arena.get(trimmedTypeId);
    expect(trimmedType.kind).toBe("function");
    if (trimmedType.kind !== "function") return;
    expect(trimmedType.parameters.map((param) => param.type)).toEqual([i32]);
    expect(trimmedType.returnType).toBe(i32);
  });
});
