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

    const ignored = Array.from(hir.expressions.values()).find(
      (expr): expr is HirLambdaExpr =>
        expr.exprKind === "lambda" && expr.parameters.length === 0,
    );
    expect(ignored).toBeDefined();
    if (!ignored) return;
    const ignoredTypeId = typing.table.getExprType(ignored.id);
    expect(ignoredTypeId).toBeDefined();
    if (ignoredTypeId === undefined) return;
    const ignoredType = typing.arena.get(ignoredTypeId);
    expect(ignoredType.kind).toBe("function");
    if (ignoredType.kind !== "function") return;
    expect(ignoredType.parameters.map((param) => param.type)).toEqual([
      i32,
      i32,
      i32,
    ]);

    const leading = lambdaByParam(hir, symbolTable, "first");
    expect(leading).toBeDefined();
    if (!leading) return;
    const leadingTypeId = typing.table.getExprType(leading.id);
    expect(leadingTypeId).toBeDefined();
    if (leadingTypeId === undefined) return;
    const leadingType = typing.arena.get(leadingTypeId);
    expect(leadingType.kind).toBe("function");
    if (leadingType.kind !== "function") return;
    expect(leading.parameters).toHaveLength(1);
    expect(leadingType.parameters.map((param) => param.type)).toEqual([
      i32,
      i32,
      i32,
    ]);

    const later = lambdaByParam(hir, symbolTable, "second");
    expect(later).toBeDefined();
    if (!later) return;
    const laterTypeId = typing.table.getExprType(later.id);
    expect(laterTypeId).toBeDefined();
    if (laterTypeId === undefined) return;
    const laterType = typing.arena.get(laterTypeId);
    expect(laterType.kind).toBe("function");
    if (laterType.kind !== "function") return;
    expect(later.parameters).toHaveLength(2);
    expect(laterType.parameters.map((param) => param.type)).toEqual([
      i32,
      i32,
      i32,
    ]);
  });

  it("rejects lambdas with more parameters than their context", () => {
    expect(() =>
      semanticsPipeline(loadAst("lambda_excess_contextual_parameters.voyd")),
    ).toThrow(/TY0027: type mismatch/i);
  });
});
