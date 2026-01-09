import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import type { TypingResult } from "../typing.js";
import type { SymbolTable } from "../../binder/index.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";

const findValueSymbol = (
  name: string,
  typing: TypingResult,
  symbolTable: SymbolTable
) =>
  Array.from(typing.valueTypes.keys()).find((symbol) => {
    const record = symbolTable.getSymbol(symbol);
    return record.kind === "value" && record.name === name;
  });

describe("object assignability", () => {
  it("rejects satisfying nominal expectations with structural objects", () => {
    const ast = loadAst("structural_to_nominal_rejection.voyd");
    expect(() => semanticsPipeline(ast)).toThrow(/call argument 1/i);
  });

  it("allows nominal objects where structural types are expected", () => {
    const ast = loadAst("nominal_to_structural_acceptance.voyd");
    const semantics = semanticsPipeline(ast);
    const { typing, hir } = semantics;
    const symbolTable = getSymbolTable(semantics);

    const resultSymbol = findValueSymbol("result", typing, symbolTable);
    expect(resultSymbol).toBeDefined();
    const resultType =
      typeof resultSymbol === "number"
        ? typing.valueTypes.get(resultSymbol)
        : undefined;
    expect(resultType).toBeDefined();
    if (typeof resultType === "number") {
      expect(typing.arena.get(resultType)).toMatchObject({
        kind: "primitive",
        name: "i32",
      });
    }

    const callExpr = Array.from(hir.expressions.values()).find(
      (expr) => expr.exprKind === "call"
    );
    expect(callExpr).toBeDefined();
    const callType = callExpr && typing.table.getExprType(callExpr.id);
    expect(callType).toBeDefined();
    if (typeof callType === "number") {
      expect(typing.arena.get(callType)).toMatchObject({
        kind: "primitive",
        name: "i32",
      });
    }
  });
});
