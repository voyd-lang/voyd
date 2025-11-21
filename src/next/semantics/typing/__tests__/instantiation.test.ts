import { describe, expect, it } from "vitest";
import { SymbolTable } from "../../binder/index.js";
import { createTypingContext } from "../context.js";
import { seedBaseObjectType, seedPrimitiveTypes } from "../registry.js";
import { ensureObjectType, resolveTypeAlias } from "../type-system.js";
import { DeclTable } from "../../decls.js";
import type { HirGraph, HirTypeExpr } from "../../hir/index.js";
import type { SourceSpan, TypeId } from "../../ids.js";

const DUMMY_SPAN: SourceSpan = { file: "<test>", start: 0, end: 0 };

const createContext = () => {
  const symbolTable = new SymbolTable({ rootOwner: 0 });
  const hir: HirGraph = {
    module: {
      kind: "module",
      id: 0,
      path: "<test>",
      scope: symbolTable.rootScope,
      ast: 0,
      span: DUMMY_SPAN,
      items: [],
      exports: [],
    },
    items: new Map(),
    statements: new Map(),
    expressions: new Map(),
  };
  const ctx = createTypingContext({
    symbolTable,
    hir,
    overloads: new Map(),
    decls: new DeclTable(),
  });
  seedPrimitiveTypes(ctx);
  seedBaseObjectType(ctx);
  return { ctx, symbolTable };
};

const primeBoxTemplate = (
  ctx: ReturnType<typeof createContext>["ctx"],
  symbolTable: SymbolTable,
  constraint?: TypeId
) => {
  const typeParamSymbol = symbolTable.declare({
    name: "T",
    kind: "type",
    declaredAt: 0,
  });
  const boxSymbol = symbolTable.declare({
    name: "Box",
    kind: "type",
    declaredAt: 0,
  });
  const typeParam = ctx.arena.freshTypeParam();
  const typeParamRef = ctx.arena.internTypeParamRef(typeParam);
  const fields = [{ name: "value", type: typeParamRef }];
  const structural = ctx.arena.internStructuralObject({ fields });
  const nominal = ctx.arena.internNominalObject({
    owner: boxSymbol,
    name: "Box",
    typeArgs: [typeParamRef],
  });
  const type = ctx.arena.internIntersection({ nominal, structural });
  ctx.objectTemplates.set(boxSymbol, {
    symbol: boxSymbol,
    params: [{ symbol: typeParamSymbol, typeParam, constraint }],
    nominal,
    structural,
    type,
    fields,
    baseNominal: undefined,
  });
  ctx.objectsByName.set("Box", boxSymbol);
  return { boxSymbol };
};

const primeAliasTemplate = (
  ctx: ReturnType<typeof createContext>["ctx"],
  symbolTable: SymbolTable,
  options: { constraint?: HirTypeExpr } = {}
) => {
  const paramSymbol = symbolTable.declare({
    name: "U",
    kind: "type",
    declaredAt: 0,
  });
  const aliasSymbol = symbolTable.declare({
    name: "Wrap",
    kind: "type",
    declaredAt: 0,
  });
  const target: HirTypeExpr = {
    typeKind: "named",
    path: ["U"],
    symbol: paramSymbol,
    ast: 0,
    span: DUMMY_SPAN,
  };
  ctx.typeAliasTemplates.set(aliasSymbol, {
    symbol: aliasSymbol,
    params: [{ symbol: paramSymbol, constraint: options.constraint }],
    target,
  });
  ctx.typeAliasTargets.set(aliasSymbol, target);
  return { aliasSymbol };
};

describe("instantiation argument handling", () => {
  it("does not cache unknown object instantiations", () => {
    const { ctx, symbolTable } = createContext();
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable);
    const unknownKey = `${boxSymbol}<${ctx.unknownType}>`;

    const info = ensureObjectType(boxSymbol, ctx, [ctx.unknownType]);
    expect(info).toBeDefined();
    expect(ctx.objectInstances.has(unknownKey)).toBe(false);
    expect(ctx.objectsByNominal.has(info?.nominal ?? -1)).toBe(false);
    expect(ctx.valueTypes.has(boxSymbol)).toBe(false);

    const boolKey = `${boxSymbol}<${ctx.boolType}>`;
    const concrete = ensureObjectType(boxSymbol, ctx, [ctx.boolType]);
    expect(ctx.objectInstances.get(boolKey)).toEqual(concrete);
    expect(ctx.valueTypes.get(boxSymbol)).toBe(concrete?.type);
  });

  it("throws for missing object type arguments in strict mode", () => {
    const { ctx, symbolTable } = createContext();
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable);
    ctx.typeCheckMode = "strict";
    expect(() => ensureObjectType(boxSymbol, ctx, [])).toThrow(
      /missing 1 type argument/
    );
  });

  it("rejects missing alias arguments and skips caching unknown instances", () => {
    const { ctx, symbolTable } = createContext();
    const { aliasSymbol } = primeAliasTemplate(ctx, symbolTable);

    ctx.typeCheckMode = "relaxed";
    const relaxed = resolveTypeAlias(aliasSymbol, ctx, []);
    expect(relaxed).toBe(ctx.unknownType);
    expect(ctx.typeAliasInstances.size).toBe(0);

    ctx.typeCheckMode = "strict";
    expect(() => resolveTypeAlias(aliasSymbol, ctx, [])).toThrow(
      /missing 1 type argument/
    );

    const applied = resolveTypeAlias(aliasSymbol, ctx, [ctx.boolType]);
    expect(applied).toBe(ctx.boolType);
    expect(ctx.typeAliasInstances.size).toBe(1);
  });

  it("enforces object generic constraints before caching instantiations", () => {
    const { ctx, symbolTable } = createContext();
    const valueConstraint = ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: ctx.boolType }],
    });
    const { boxSymbol } = primeBoxTemplate(ctx, symbolTable, valueConstraint);

    expect(() => ensureObjectType(boxSymbol, ctx, [ctx.boolType])).toThrow(
      /constraint/
    );

    const payload = ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: ctx.boolType }],
    });
    const info = ensureObjectType(boxSymbol, ctx, [payload]);
    expect(info?.type).toBeDefined();
  });

  it("rejects alias instantiation when constraints fail", () => {
    const { ctx, symbolTable } = createContext();
    const constraint: HirTypeExpr = {
      typeKind: "object",
      fields: [
        {
          name: "value",
          type: {
            typeKind: "named",
            path: ["i32"],
            ast: 0,
            span: DUMMY_SPAN,
          },
          span: DUMMY_SPAN,
        },
      ],
      ast: 0,
      span: DUMMY_SPAN,
    };
    const { aliasSymbol } = primeAliasTemplate(ctx, symbolTable, {
      constraint,
    });

    expect(() => resolveTypeAlias(aliasSymbol, ctx, [ctx.boolType])).toThrow(
      /constraint/
    );

    const i32 =
      ctx.primitiveCache.get("i32") ?? ctx.arena.internPrimitive("i32");
    const valid = ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: i32 }],
    });
    const resolved = resolveTypeAlias(aliasSymbol, ctx, [valid]);
    expect(resolved).toBe(valid);
  });

  it("unifies composite types with variance-aware substitutions", () => {
    const { ctx } = createContext();
    const param = ctx.arena.freshTypeParam();
    const paramRef = ctx.arena.internTypeParamRef(param);
    const genericFn = ctx.arena.internFunction({
      parameters: [{ type: paramRef, optional: false }],
      returnType: ctx.arena.internUnion([paramRef, ctx.voidType]),
      effects: ctx.defaultEffectRow,
    });
    const concreteFn = ctx.arena.internFunction({
      parameters: [{ type: ctx.boolType, optional: false }],
      returnType: ctx.arena.internUnion([ctx.boolType, ctx.voidType]),
      effects: ctx.defaultEffectRow,
    });

    const result = ctx.arena.unify(concreteFn, genericFn, {
      location: 0,
      reason: "function variance",
      variance: "covariant",
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.substitution.get(param)).toBe(ctx.boolType);
  });
});
