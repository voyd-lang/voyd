import { describe, expect, it } from "vitest";

import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";

const nominalNameOf = (
  typeId: number,
  {
    arena,
  }: Pick<ReturnType<typeof semanticsPipeline>["typing"], "arena">
): string => {
  const desc = arena.get(typeId);
  if (desc.kind === "nominal-object" && typeof desc.name === "string") {
    return desc.name;
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    const nominal = arena.get(desc.nominal);
    if (nominal.kind === "nominal-object") {
      return typeof nominal.name === "string"
        ? nominal.name
        : nominal.kind;
    }
  }
  return desc.kind;
};

describe("return type inference", () => {
  it("infers a union when multiple nominal objects are returned", () => {
    const semantics = semanticsPipeline(loadAst("return_union_inference.voyd"));
    const { typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const chooseSymbol = symbolTable.resolve("choose", symbolTable.rootScope);
    expect(typeof chooseSymbol).toBe("number");
    if (typeof chooseSymbol !== "number") return;

    const chooseSignature = typing.functions.getSignature(chooseSymbol);
    expect(chooseSignature).toBeDefined();
    if (!chooseSignature) return;

    const returnDesc = typing.arena.get(chooseSignature.returnType);
    expect(returnDesc.kind).toBe("union");
    if (returnDesc.kind !== "union") return;

    const memberNames = returnDesc.members
      .map((member) => nominalNameOf(member, typing))
      .sort();
    expect(memberNames).toEqual(["Other", "Some"]);
  });
});
