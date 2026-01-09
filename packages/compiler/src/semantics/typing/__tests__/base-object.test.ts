import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";
import type { SymbolTable } from "../../binder/index.js";

const findTypeByName = (
  name: string,
  typing: ReturnType<typeof semanticsPipeline>["typing"],
  symbolTable: SymbolTable
) => {
  for (const [symbol, typeId] of typing.valueTypes.entries()) {
    const record = symbolTable.getSymbol(symbol);
    if (record.name === name) {
      return { symbol, typeId };
    }
  }
  return undefined;
};

describe("base Object support", () => {
  it("treats nominal and structural objects as Object", () => {
    const ast = loadAst("base_object_compat.voyd");
    const semantics = semanticsPipeline(ast);
    const { typing, hir } = semantics;
    const symbolTable = getSymbolTable(semantics);

    const baseEntry = findTypeByName("Object", typing, symbolTable);
    expect(baseEntry?.typeId).toBeDefined();
    const baseDesc = typing.arena.get(baseEntry!.typeId);
    expect(baseDesc.kind).toBe("intersection");
    if (baseDesc.kind === "intersection") {
      expect(baseDesc.nominal).toBeDefined();
      expect(baseDesc.structural).toBeDefined();
    }

    const fooType = findTypeByName("Foo", typing, symbolTable)?.typeId;
    expect(fooType).toBeDefined();
    const fooDesc = typing.arena.get(fooType!);
    expect(fooDesc.kind).toBe("intersection");

    const paramType = findTypeByName("o", typing, symbolTable)?.typeId;
    expect(paramType).toBeDefined();
    expect(paramType).toBe(baseEntry!.typeId);

    const calls = Array.from(hir.expressions.values()).filter(
      (expr) => expr.exprKind === "call"
    );
    expect(calls.length).toBeGreaterThan(0);
    calls.forEach((call) => {
      const type = typing.table.getExprType(call.id);
      expect(type).toBeDefined();
      const desc = typing.arena.get(type!);
      expect(desc).toMatchObject({ kind: "primitive", name: "i32" });
    });

    const structuralLiteral = Array.from(hir.expressions.values()).find(
      (expr) =>
        expr.exprKind === "object-literal" &&
        expr.literalKind === "structural"
    );
    expect(structuralLiteral).toBeDefined();
    const structuralLiteralType =
      structuralLiteral && typing.table.getExprType(structuralLiteral.id);
    expect(structuralLiteralType).toBeDefined();
    if (typeof structuralLiteralType === "number") {
      expect(typing.arena.get(structuralLiteralType).kind).toBe(
        "structural-object"
      );
    }
  });
});
