import { describe, expect, it } from "vitest";
import type { HirObjectDecl } from "../../hir/nodes.js";
import type { SymbolId, TypeId } from "../../ids.js";
import { semanticsPipeline } from "../../pipeline.js";
import type { TypingResult } from "../typing.js";
import type { NominalObjectType } from "../type-arena.js";
import { loadAst } from "../../__tests__/load-ast.js";
import { getSymbolTable } from "../../_internal/symbol-table.js";
import type { SymbolTable } from "../../binder/index.js";

const findValueSymbol = (
  name: string,
  valueTypes: ReadonlyMap<SymbolId, TypeId>,
  symbolTable: SymbolTable
): SymbolId | undefined => {
  for (const symbol of valueTypes.keys()) {
    const record = symbolTable.getSymbol(symbol);
    const metadata = (record.metadata ?? {}) as { entity?: string };
    if (record.name === name && record.kind === "value" && !metadata.entity) {
      return symbol;
    }
  }
  return undefined;
};

const getNominalArgPrimitive = (
  typeId: TypeId | undefined,
  typing: TypingResult
): string | undefined => {
  if (typeof typeId !== "number") {
    return undefined;
  }
  const nominal =
    unwrapNominal(typeId, typing) ??
    unwrapNominalFromIntersection(typeId, typing);
  if (!nominal) {
    return undefined;
  }
  const typeArg = nominal.typeArgs[0];
  if (typeof typeArg !== "number") {
    return undefined;
  }
  const argDesc = typing.arena.get(typeArg);
  return argDesc.kind === "primitive" ? argDesc.name : undefined;
};

const unwrapNominalFromIntersection = (
  typeId: TypeId,
  typing: TypingResult
): Readonly<NominalObjectType> | undefined => {
  const desc = typing.arena.get(typeId);
  if (desc.kind === "intersection" && typeof desc.nominal === "number") {
    const nominal = typing.arena.get(desc.nominal);
    return nominal.kind === "nominal-object" ? nominal : undefined;
  }
  return undefined;
};

const unwrapNominal = (
  typeId: TypeId,
  typing: TypingResult
): Readonly<NominalObjectType> | undefined => {
  const desc = typing.arena.get(typeId);
  return desc.kind === "nominal-object" ? desc : undefined;
};

describe("nominal object type parameters", () => {
  it("propagates type arguments through aliases and literals", () => {
    const ast = loadAst("object_generics.voyd");
    const semantics = semanticsPipeline(ast);
    const { hir, typing } = semantics;
    const symbolTable = getSymbolTable(semantics);
    const root = symbolTable.rootScope;

    const boxSymbol = symbolTable.resolve("Box", root);
    const box2Symbol = symbolTable.resolve("Box2", root);
    expect(boxSymbol).toBeDefined();
    expect(box2Symbol).toBeDefined();

    const boxDecl = Array.from(hir.items.values()).find(
      (item): item is HirObjectDecl =>
        item.kind === "object" && item.symbol === boxSymbol
    );
    const box2Decl = Array.from(hir.items.values()).find(
      (item): item is HirObjectDecl =>
        item.kind === "object" && item.symbol === box2Symbol
    );
    expect(boxDecl?.typeParameters?.length).toBe(1);
    expect(box2Decl?.typeParameters?.length).toBe(1);

    const doubleSymbol = symbolTable.resolve("double", root);
    expect(doubleSymbol).toBeDefined();
    const doubleScheme =
      typeof doubleSymbol === "number"
        ? typing.table.getSymbolScheme(doubleSymbol)
        : undefined;
    expect(doubleScheme).toBeDefined();
    if (!doubleScheme) {
      return;
    }
    const doubleType = typing.arena.instantiate(doubleScheme, []);
    const doubleDesc = typing.arena.get(doubleType);
    expect(doubleDesc.kind).toBe("function");
    if (doubleDesc.kind !== "function") {
      return;
    }
    expect(getNominalArgPrimitive(doubleDesc.returnType, typing)).toBe("i32");

    const aSymbol = findValueSymbol("a", typing.valueTypes, symbolTable);
    const bSymbol = findValueSymbol("b", typing.valueTypes, symbolTable);
    const cSymbol = findValueSymbol("c", typing.valueTypes, symbolTable);
    expect(aSymbol).toBeDefined();
    expect(bSymbol).toBeDefined();
    expect(cSymbol).toBeDefined();

    const aType = aSymbol ? typing.valueTypes.get(aSymbol) : undefined;
    const bType = bSymbol ? typing.valueTypes.get(bSymbol) : undefined;
    const cType = cSymbol ? typing.valueTypes.get(cSymbol) : undefined;

    expect(getNominalArgPrimitive(aType, typing)).toBe("i32");
    expect(getNominalArgPrimitive(bType, typing)).toBe("f64");
    expect(getNominalArgPrimitive(cType, typing)).toBe("i32");
  });
});
