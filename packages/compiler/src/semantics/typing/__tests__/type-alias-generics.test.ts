import { describe, expect, it } from "vitest";
import type { HirTypeAlias } from "../../hir/nodes.js";
import type { SymbolId, TypeId } from "../../ids.js";
import { semanticsPipeline } from "../../pipeline.js";
import type { TypingResult } from "../typing.js";
import type { NominalObjectType } from "../type-arena.js";
import { loadAst } from "../../__tests__/load-ast.js";

const nominalFor = (
  typeId: TypeId,
  typing: TypingResult
): NominalObjectType | undefined => {
  const desc = typing.arena.get(typeId);
  if (desc.kind === "nominal-object") {
    return desc;
  }
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    const nominal = typing.arena.get(desc.nominal);
    return nominal.kind === "nominal-object" ? nominal : undefined;
  }
  return undefined;
};

const primitiveName = (typeId: TypeId, typing: TypingResult): string | null => {
  const desc = typing.arena.get(typeId);
  return desc.kind === "primitive" ? desc.name : null;
};

describe("type alias type parameters", () => {
  it("propagates type arguments through type aliases", () => {
    const ast = loadAst("type_alias_generics.voyd");
    const { symbolTable, hir, typing } = semanticsPipeline(ast);
    const root = symbolTable.rootScope;

    const optional = Array.from(hir.items.values()).find(
      (item): item is HirTypeAlias =>
        item.kind === "type-alias" &&
        symbolTable.getSymbol(item.symbol).name === "Optional"
    );
    expect(optional?.typeParameters?.length).toBe(1);

    const someSymbol = symbolTable.resolve("Some", root);
    const noneSymbol = symbolTable.resolve("None", root);
    expect(someSymbol).toBeDefined();
    expect(noneSymbol).toBeDefined();

    const getIntSymbol = symbolTable.resolve("get_int", root);
    expect(getIntSymbol).toBeDefined();
    const getIntScheme =
      typeof getIntSymbol === "number"
        ? typing.table.getSymbolScheme(getIntSymbol)
        : undefined;
    expect(getIntScheme).toBeDefined();
    if (!getIntScheme) {
      return;
    }

    const getIntType = typing.arena.instantiate(getIntScheme, []);
    const getIntDesc = typing.arena.get(getIntType);
    expect(getIntDesc.kind).toBe("function");
    if (getIntDesc.kind !== "function") {
      return;
    }

    const paramType = getIntDesc.parameters[0]?.type;
    expect(paramType).toBeDefined();
    if (typeof paramType !== "number") {
      return;
    }
    const paramDesc = typing.arena.get(paramType);
    expect(paramDesc.kind).toBe("union");
    if (paramDesc.kind !== "union") {
      return;
    }

    const memberNominals = paramDesc.members
      .map((member) => nominalFor(member, typing))
      .filter(Boolean) as NominalObjectType[];

    const expectNominal = (
      symbol: SymbolId | undefined,
      args?: readonly string[]
    ) => {
      if (typeof symbol !== "number") {
        return;
      }
      const nominal = memberNominals.find(
        (candidate) => candidate.owner.symbol === symbol
      );
      expect(nominal).toBeDefined();
      if (!nominal || !args) {
        return;
      }
      const names = nominal.typeArgs.map(
        (arg) => (typeof arg === "number" ? primitiveName(arg, typing) : null)
      );
      expect(names).toEqual(args);
    };

    expectNominal(someSymbol, ["i32"]);
    expectNominal(noneSymbol);

    const mainSymbol = symbolTable.resolve("main", root);
    expect(mainSymbol).toBeDefined();
    const mainScheme =
      typeof mainSymbol === "number"
        ? typing.table.getSymbolScheme(mainSymbol)
        : undefined;
    expect(mainScheme).toBeDefined();
    if (!mainScheme) {
      return;
    }
    const mainType = typing.arena.instantiate(mainScheme, []);
    const mainDesc = typing.arena.get(mainType);
    expect(mainDesc.kind).toBe("function");
    if (mainDesc.kind !== "function") {
      return;
    }
    const returnType = mainDesc.returnType;
    expect(primitiveName(returnType, typing)).toBe("i32");
  });
});
