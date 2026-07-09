import { describe, expect, it } from "vitest";
import type { HirVisibility } from "../../hir/index.js";
import type { SymbolId } from "../../ids.js";
import { createTypeArena } from "../type-arena.js";

const moduleVisibility = (): HirVisibility => ({ level: "module", api: false });

describe("TypeArena shape normalization", () => {
  it("collapses singleton unions to their member", () => {
    const arena = createTypeArena();
    const bool = arena.internPrimitive("bool");

    expect(arena.internUnion([bool])).toBe(bool);
    expect(arena.internUnion([arena.internUnion([bool])])).toBe(bool);
  });

  it("deduplicates identical structural field shapes", () => {
    const arena = createTypeArena();
    const i32 = arena.internPrimitive("i32");
    const structural = arena.internStructuralObject({
      fields: [
        { name: "value", type: i32 },
        { name: "value", type: i32, optional: false },
      ],
    });

    const desc = arena.get(structural);
    if (desc.kind !== "structural-object") {
      throw new Error(`expected structural object, got ${desc.kind}`);
    }
    expect(desc.fields).toEqual([{ name: "value", type: i32, optional: false }]);
  });

  it("preserves structural field access metadata when interning", () => {
    const arena = createTypeArena();
    const i32 = arena.internPrimitive("i32");
    const owner = 42 as SymbolId;
    const type = arena.internStructuralObject({
      fields: [
        {
          name: "value",
          type: i32,
          visibility: { level: "object" },
          owner,
          packageId: "pkg-a",
        },
      ],
    });

    const desc = arena.get(type);
    if (desc.kind !== "structural-object") {
      throw new Error(`expected structural object, got ${desc.kind}`);
    }
    expect(desc.fields[0]).toMatchObject({
      name: "value",
      type: i32,
      optional: false,
      visibility: { level: "object" },
      owner,
      packageId: "pkg-a",
    });
  });

  it("does not merge structural objects with different field access metadata", () => {
    const arena = createTypeArena();
    const i32 = arena.internPrimitive("i32");
    const restrictedField = {
      name: "value",
      type: i32,
      visibility: moduleVisibility(),
      owner: 1 as SymbolId,
      packageId: "pkg",
    };
    const restrictedShape = arena.internStructuralObject({
      fields: [restrictedField],
    });
    const publicShape = arena.internStructuralObject({
      fields: [{ name: "value", type: i32 }],
    });

    expect(restrictedShape).not.toBe(publicShape);
  });

  it("preserves canonical descriptor ids across snapshot restore", () => {
    const arena = createTypeArena();
    const i32 = arena.internPrimitive("i32");
    const canonical = arena.createRecursiveType(() => ({
      kind: "structural-object",
      fields: [{ name: "value", type: i32 }],
    }));

    expect(
      arena.internStructuralObject({
        fields: [{ name: "value", type: i32 }],
      }),
    ).toBe(canonical);

    const restored = createTypeArena(arena.snapshot());

    expect(
      restored.internStructuralObject({
        fields: [{ name: "value", type: i32 }],
      }),
    ).toBe(canonical);
  });
});
