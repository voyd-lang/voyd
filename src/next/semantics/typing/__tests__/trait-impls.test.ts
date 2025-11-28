import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";

describe("trait implementations", () => {
  it("registers trait types and allows impls that satisfy required methods", () => {
    const ast = loadAst("trait_area.voyd");
    const { symbolTable, typing } = semanticsPipeline(ast);
    const areaSymbol = symbolTable.resolve("Area", symbolTable.rootScope);
    expect(areaSymbol).toBeDefined();

    const traitType = typing.valueTypes.get(areaSymbol!);
    expect(traitType).toBeDefined();
    if (!traitType) return;
    const desc = typing.arena.get(traitType);
    expect(desc.kind).toBe("trait");
  });

  it("substitutes trait type parameters when comparing nested type arguments", () => {
    const ast = loadAst("trait_generic_nested_args.voyd");
    expect(() => semanticsPipeline(ast)).not.toThrow();
  });

  it("errors when an impl does not provide required trait methods", () => {
    const ast = loadAst("trait_area_invalid.voyd");
    expect(() => semanticsPipeline(ast)).toThrowError(
      /missing trait method.*area/i
    );
  });

  it("errors when an impl method signature does not match the trait", () => {
    const ast = loadAst("trait_area_wrong_return.voyd");
    expect(() => semanticsPipeline(ast)).toThrowError(
      /return type mismatch/i
    );
  });
});
