import { describe, expect, it } from "vitest";
import { loadAst } from "../../__tests__/load-ast.js";
import { semanticsPipeline } from "../../pipeline.js";

const findSymbolByName = (
  name: string,
  kind: "value" | "parameter",
  symbolTable: ReturnType<typeof semanticsPipeline>["symbolTable"]
) =>
  symbolTable
    .snapshot()
    .symbols.filter(Boolean)
    .find((record) => record?.name === name && record?.kind === kind)?.id;

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
    const { typing, symbolTable, hir } = semanticsPipeline(ast);

    const pairParam = findSymbolByName("pair", "parameter", symbolTable);
    const pairBinding = findSymbolByName("pair", "value", symbolTable);
    const aBinding = findSymbolByName("a", "value", symbolTable);
    const bBinding = findSymbolByName("b", "value", symbolTable);
    const xBinding = findSymbolByName("x", "value", symbolTable);
    const yBinding = findSymbolByName("y", "value", symbolTable);

    expectStructuralTuple(pairParam && typing.valueTypes.get(pairParam), typing, 2);
    expectStructuralTuple(pairBinding && typing.valueTypes.get(pairBinding), typing, 2);

    const tupleExpr = Array.from(hir.expressions.values()).find(
      (expr) => expr.exprKind === "tuple" && expr.elements.length === 2
    );
    expect(tupleExpr).toBeDefined();
    const tupleType = tupleExpr && typing.table.getExprType(tupleExpr.id);
    expectStructuralTuple(tupleType, typing, 2);

    [aBinding, bBinding, xBinding, yBinding].forEach((binding) => {
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
