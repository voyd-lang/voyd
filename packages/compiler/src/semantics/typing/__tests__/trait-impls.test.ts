import { describe, expect, it } from "vitest";
import { semanticsPipeline } from "../../pipeline.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";
import { symbolRefKey } from "../symbol-ref-utils.js";
import type { HirFunction } from "../../hir/nodes.js";

describe("trait implementations", () => {
  it("registers trait types and allows impls that satisfy required methods", () => {
    const ast = loadAst("trait_area.voyd");
    const semantics = semanticsPipeline(ast);
    const { typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
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

  it("errors when a trait is implemented twice for the same target", () => {
    const ast = loadAst("trait_impl_duplicate_direct.voyd");
    expect(() => semanticsPipeline(ast)).toThrowError(
      /duplicate trait implementation|already defines overload/i
    );
  });

  it("errors when blanket and concrete trait impls overlap", () => {
    const ast = loadAst("trait_impl_duplicate_blanket_overlap.voyd");
    expect(() => semanticsPipeline(ast)).toThrowError(
      /duplicate trait implementation/i
    );
  });

  it("errors when equivalent generic trait impl templates are duplicated", () => {
    const ast = loadAst("trait_impl_duplicate_generic_equivalent.voyd");
    expect(() => semanticsPipeline(ast)).toThrowError(
      /duplicate trait implementation/i
    );
  });

  it("allows multiple non-trait object extension impl blocks", () => {
    const ast = loadAst("impl_object_extension_multiple_blocks.voyd");
    expect(() => semanticsPipeline(ast)).not.toThrow();
  });

  it("type-checks blanket impls over type parameters", () => {
    const ast = loadAst("blanket_scalable.voyd");
    const semantics = semanticsPipeline(ast);
    const { typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const scaleSymbol = Array.from(semantics.hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" &&
        symbolTable.getSymbol(item.symbol).name === "scale"
    )?.symbol;
    expect(typeof scaleSymbol).toBe("number");
    if (!scaleSymbol) return;
    const instantiations = typing.functionInstantiationInfo.get(
      symbolRefKey({ moduleId: semantics.moduleId, symbol: scaleSymbol })
    );
    expect(instantiations?.size).toBeGreaterThan(0);
  });

  it("records instantiations for blanket impls on generic objects", () => {
    const ast = loadAst("blanket_summable_box.voyd");
    const semantics = semanticsPipeline(ast);
    const { typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const sumSymbol = Array.from(semantics.hir.items.values()).find(
      (item): item is HirFunction =>
        item.kind === "function" &&
        symbolTable.getSymbol(item.symbol).name === "sum"
    )?.symbol;
    expect(typeof sumSymbol).toBe("number");
    if (!sumSymbol) return;
    const instantiations = typing.functionInstantiationInfo.get(
      symbolRefKey({ moduleId: semantics.moduleId, symbol: sumSymbol })
    );
    expect(instantiations?.size).toBeGreaterThanOrEqual(2);
  });
});
