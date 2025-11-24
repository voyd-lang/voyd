import { describe, expect, it } from "vitest";
import { SymbolTable } from "../../binder/index.js";
import { DeclTable } from "../../decls.js";
import { createTypingContext, createTypingState } from "../context.js";
import { seedBaseObjectType, seedPrimitiveTypes } from "../registry.js";
import { getPrimitiveType, typeSatisfies } from "../type-system.js";
import type { HirGraph } from "../../hir/index.js";
import type { SourceSpan, TypeId } from "../../ids.js";
import type { TypingState } from "../types.js";

const DUMMY_SPAN: SourceSpan = { file: "<test>", start: 0, end: 0 };

const createContext = (mode: TypingState["mode"] = "relaxed") => {
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
  const state = createTypingState(mode);
  return { ctx, state, symbolTable };
};

const registerNominal = ({
  ctx,
  symbolTable,
  name,
  fields,
  baseNominal,
}: {
  ctx: ReturnType<typeof createContext>["ctx"];
  symbolTable: SymbolTable;
  name: string;
  fields: { name: string; type: TypeId }[];
  baseNominal?: TypeId;
}) => {
  const symbol = symbolTable.declare({
    name,
    kind: "type",
    declaredAt: ctx.hir.module.ast,
  });
  const structural = ctx.arena.internStructuralObject({ fields });
  const nominal = ctx.arena.internNominalObject({
    owner: symbol,
    name,
    typeArgs: [],
  });
  const type = ctx.arena.internIntersection({ nominal, structural });
  ctx.objects.registerTemplate({
    symbol,
    params: [],
    nominal,
    structural,
    type,
    fields,
    baseNominal,
  });
  ctx.objects.setName(name, symbol);
  ctx.objects.addInstance(`${symbol}<>`, {
    nominal,
    structural,
    type,
    fields,
    baseNominal,
  });
  return { symbol, nominal, structural, type };
};

describe("type satisfaction semantics", () => {
  it("requires nominal compatibility unless the expectation is the base object", () => {
    const { ctx, state, symbolTable } = createContext();
    const valueType = getPrimitiveType(ctx, "i32");

    const widget = registerNominal({
      ctx,
      symbolTable,
      name: "Widget",
      fields: [{ name: "value", type: valueType }],
    });
    const imposter = registerNominal({
      ctx,
      symbolTable,
      name: "Imposter",
      fields: [{ name: "value", type: valueType }],
    });
    const structuralOnly = ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: valueType }],
    });

    expect(typeSatisfies(structuralOnly, widget.type, ctx, state)).toBe(false);
    expect(typeSatisfies(imposter.type, widget.type, ctx, state)).toBe(false);
    expect(typeSatisfies(structuralOnly, ctx.objects.base.type, ctx, state)).toBe(
      true
    );
  });

  it("treats unknown as satisfiable only in relaxed mode, including within unions", () => {
    const relaxed = createContext();
    const strict = createContext("strict");
    const relaxedBool = getPrimitiveType(relaxed.ctx, "bool");
    const strictBool = getPrimitiveType(strict.ctx, "bool");

    const relaxedUnion = relaxed.ctx.arena.internUnion([
      relaxed.ctx.primitives.unknown,
      relaxedBool,
    ]);
    expect(
      typeSatisfies(relaxedUnion, relaxedBool, relaxed.ctx, relaxed.state)
    ).toBe(true);

    const strictUnion = strict.ctx.arena.internUnion([
      strict.ctx.primitives.unknown,
      strictBool,
    ]);
    expect(
      typeSatisfies(strictUnion, strictBool, strict.ctx, strict.state)
    ).toBe(false);

    const expectedUnion = strict.ctx.arena.internUnion([
      strict.ctx.primitives.unknown,
      strictBool,
    ]);
    expect(
      typeSatisfies(strictBool, expectedUnion, strict.ctx, strict.state)
    ).toBe(true);
  });
});
