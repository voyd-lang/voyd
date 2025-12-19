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

  it("distributes structural expectations through unions and nominal bases", () => {
    const { ctx, state, symbolTable } = createContext();
    const valueType = getPrimitiveType(ctx, "bool");

    const structural = ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: valueType }],
    });
    const structuralUnion = ctx.arena.internUnion([structural, valueType]);
    expect(typeSatisfies(structuralUnion, ctx.objects.base.type, ctx, state)).toBe(
      false
    );

    const expectedUnion = ctx.arena.internUnion([
      ctx.objects.base.type,
      valueType,
    ]);
    expect(typeSatisfies(structural, expectedUnion, ctx, state)).toBe(true);

    const parent = registerNominal({
      ctx,
      symbolTable,
      name: "Parent",
      fields: [{ name: "value", type: valueType }],
      baseNominal: ctx.objects.base.nominal,
    });
    const child = registerNominal({
      ctx,
      symbolTable,
      name: "Child",
      fields: [
        { name: "value", type: valueType },
        { name: "extra", type: valueType },
      ],
      baseNominal: parent.nominal,
    });
    const nominalUnion = ctx.arena.internUnion([parent.type, valueType]);
    expect(typeSatisfies(child.type, nominalUnion, ctx, state)).toBe(true);
  });

  it("compares unions of nominal objects structurally through unification", () => {
    const { ctx, state, symbolTable } = createContext();
    const valueType = getPrimitiveType(ctx, "i32");

    const alpha = registerNominal({
      ctx,
      symbolTable,
      name: "Alpha",
      fields: [{ name: "value", type: valueType }],
    });
    const beta = registerNominal({
      ctx,
      symbolTable,
      name: "Beta",
      fields: [{ name: "value", type: valueType }],
    });
    const expectedStructural = ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: valueType }],
    });
    const compatibleUnion = ctx.arena.internUnion([alpha.type, beta.type]);
    expect(typeSatisfies(compatibleUnion, expectedStructural, ctx, state)).toBe(
      true
    );

    const mismatched = registerNominal({
      ctx,
      symbolTable,
      name: "Mismatched",
      fields: [{ name: "other", type: valueType }],
    });
    const failingUnion = ctx.arena.internUnion([alpha.type, mismatched.type]);
    expect(typeSatisfies(failingUnion, expectedStructural, ctx, state)).toBe(
      false
    );
  });

  it("uses structural components of intersections when satisfying the base object", () => {
    const { ctx, state, symbolTable } = createContext("strict");
    const valueType = getPrimitiveType(ctx, "bool");
    const registered = registerNominal({
      ctx,
      symbolTable,
      name: "Intersected",
      fields: [{ name: "value", type: valueType }],
    });
    const widenedStructural = ctx.arena.internStructuralObject({
      fields: [
        { name: "value", type: valueType },
        { name: "extra", type: valueType },
      ],
    });
    const augmentedIntersection = ctx.arena.internIntersection({
      nominal: registered.nominal,
      structural: widenedStructural,
    });

    expect(
      typeSatisfies(augmentedIntersection, ctx.objects.base.type, ctx, state)
    ).toBe(true);
  });

  it("satisfies nominal expectations that include structural intersections", () => {
    const { ctx, state, symbolTable } = createContext();
    const valueType = getPrimitiveType(ctx, "bool");
    const fields = [{ name: "value", type: valueType }];
    const widget = registerNominal({
      ctx,
      symbolTable,
      name: "Widget",
      fields,
    });

    const expected = ctx.arena.internIntersection({
      nominal: widget.nominal,
      structural: ctx.arena.internStructuralObject({ fields }),
    });

    expect(typeSatisfies(widget.nominal, expected, ctx, state)).toBe(true);
  });

  it("compares unions structurally when a member is a nominal intersection", () => {
    const { ctx, state, symbolTable } = createContext();
    const valueType = getPrimitiveType(ctx, "i32");
    const fields = [{ name: "value", type: valueType }];
    const widget = registerNominal({
      ctx,
      symbolTable,
      name: "Widget",
      fields,
    });
    const structuralOnly = ctx.arena.internStructuralObject({ fields });
    const expected = ctx.arena.internUnion([widget.type, valueType]);

    expect(typeSatisfies(structuralOnly, expected, ctx, state)).toBe(true);
  });

  it("threads allowUnknown through unification during structural comparison", () => {
    const relaxed = createContext();
    const relaxedBool = getPrimitiveType(relaxed.ctx, "bool");
    const relaxedActual = relaxed.ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: relaxedBool }],
    });
    const relaxedExpected = relaxed.ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: relaxed.ctx.primitives.unknown }],
    });

    expect(
      typeSatisfies(relaxedActual, relaxedExpected, relaxed.ctx, relaxed.state)
    ).toBe(true);

    const strict = createContext("strict");
    const strictBool = getPrimitiveType(strict.ctx, "bool");
    const strictActual = strict.ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: strictBool }],
    });
    const strictExpected = strict.ctx.arena.internStructuralObject({
      fields: [{ name: "value", type: strict.ctx.primitives.unknown }],
    });

    expect(
      typeSatisfies(strictActual, strictExpected, strict.ctx, strict.state)
    ).toBe(false);
  });
});
