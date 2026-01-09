import { describe, expect, it } from "vitest";
import { loadAst } from "../../__tests__/load-ast.js";
import { semanticsPipeline } from "../../pipeline.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";
import type { SymbolTable } from "../../binder/index.js";

const findSymbolByName = (
  name: string,
  kind: "value" | "parameter",
  symbolTable: SymbolTable
) =>
  symbolTable
    .snapshot()
    .symbols.find((record) => record.name === name && record.kind === kind)?.id;

const expectStructuralTuple = (
  typeId: number | undefined,
  typing: ReturnType<typeof semanticsPipeline>["typing"],
  expectedLength: number
) => {
  expect(typeId).toBeDefined();
  if (typeof typeId !== "number") return;
  const desc = typing.arena.get(typeId);
  expect(desc.kind).toBe("structural-object");
  if (desc.kind === "structural-object") {
    expect(desc.fields.length).toBe(expectedLength);
    desc.fields.forEach((field, index) => {
      expect(field.name).toBe(`${index}`);
      expect(typing.arena.get(field.type)).toMatchObject({
        kind: "primitive",
        name: "i32",
      });
    });
  }
};

describe("tuple typing", () => {
  it("treats tuples as structural objects with numeric field names", () => {
    const ast = loadAst("tuples.voyd");
    const semantics = semanticsPipeline(ast);
    const { typing, hir } = semantics;
    const symbolTable = getSymbolTable(semantics);

    const pairParam = findSymbolByName("pair", "parameter", symbolTable);
    const aBinding = findSymbolByName("a", "value", symbolTable);
    const bBinding = findSymbolByName("b", "value", symbolTable);
    const leftBinding = findSymbolByName("left", "value", symbolTable);
    const rightBinding = findSymbolByName("right", "value", symbolTable);

    expectStructuralTuple(pairParam && typing.valueTypes.get(pairParam), typing, 2);

    const tupleExpr = Array.from(hir.expressions.values()).find(
      (expr) => expr.exprKind === "tuple" && expr.elements.length === 2
    );
    expect(tupleExpr).toBeDefined();
    const tupleType = tupleExpr && typing.table.getExprType(tupleExpr.id);
    expectStructuralTuple(tupleType, typing, 2);

    [aBinding, bBinding, leftBinding, rightBinding].forEach((binding) => {
      const type = binding && typing.valueTypes.get(binding);
      expect(type).toBeDefined();
      if (typeof type === "number") {
        expect(typing.arena.get(type)).toMatchObject({
          kind: "primitive",
          name: "i32",
        });
      }
    });
  });
});
