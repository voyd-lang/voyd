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

describe("FixedArray typing", () => {
  it("interns a fixed-array descriptor for type annotations", () => {
    const { typing, symbolTable, hir } = semanticsPipeline(
      loadAst("fixed_array_types.voyd")
    );

    const arrSymbol = findSymbolByName("arr", "parameter", symbolTable);
    expect(arrSymbol).toBeDefined();
    const arrType = arrSymbol && typing.valueTypes.get(arrSymbol);
    expect(arrType).toBeDefined();
    if (typeof arrType === "number") {
      const desc = typing.arena.get(arrType);
      expect(desc.kind).toBe("fixed-array");
      if (desc.kind === "fixed-array") {
        expect(typing.arena.get(desc.element)).toMatchObject({
          kind: "primitive",
          name: "i32",
        });
      }
    }

    const identifierExpr = Array.from(hir.expressions.values()).find(
      (expr) => expr.exprKind === "identifier" && expr.symbol === arrSymbol
    );
    expect(identifierExpr).toBeDefined();
    if (identifierExpr) {
      const exprType = typing.table.getExprType(identifierExpr.id);
      expect(exprType).toBe(arrType);
    }

    const fnSymbol = findSymbolByName("identity", "value", symbolTable);
    const signature = fnSymbol && typing.functions.getSignature(fnSymbol);
    expect(signature?.returnType).toBe(arrType);
  });

  it("requires exactly one FixedArray type argument", () => {
    expect(() => semanticsPipeline(loadAst("fixed_array_missing_arg.voyd"))).toThrow(
      /FixedArray is missing 1 type argument/
    );
    expect(() => semanticsPipeline(loadAst("fixed_array_extra_arg.voyd"))).toThrow(
      /FixedArray argument count mismatch: expected 1, received 2/
    );
  });
});
