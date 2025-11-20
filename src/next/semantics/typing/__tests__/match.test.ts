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

describe("match expressions", () => {
  it("typechecks unions and narrows match arms", () => {
    const ast = loadAst("unions_match.voyd");
    const { typing, symbolTable, hir } = semanticsPipeline(ast);

    const numSymbol = findSymbolByName("num", "value", symbolTable);
    expect(numSymbol).toBeDefined();
    const numTypeId =
      typeof numSymbol === "number" ? typing.valueTypes.get(numSymbol) : undefined;
    expect(numTypeId).toBeDefined();
    if (typeof numTypeId !== "number") {
      return;
    }

    const numType = typing.arena.get(numTypeId);
    expect(numType).toMatchObject({ kind: "function" });
    if (numType.kind !== "function") {
      return;
    }

    const petParamType = numType.parameters[0]!.type;
    const petUnion = typing.arena.get(petParamType);
    expect(petUnion).toMatchObject({ kind: "union" });
    if (petUnion.kind === "union") {
      expect(petUnion.members.length).toBe(3);
    }

    const matchExpr = Array.from(hir.expressions.values()).find(
      (candidate) => candidate.exprKind === "match"
    );
    expect(matchExpr).toBeDefined();
    const matchType =
      matchExpr && typing.table.getExprType(matchExpr.id as number);
    expect(matchType).toBeDefined();
    if (typeof matchType === "number") {
      expect(typing.arena.get(matchType)).toMatchObject({
        kind: "primitive",
        name: "i32",
      });
    }
  });
});
