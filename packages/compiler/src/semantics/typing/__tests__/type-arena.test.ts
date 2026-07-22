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

  it("keeps natural field ordering when comparisons are cached", () => {
    const arena = createTypeArena();
    const i32 = arena.internPrimitive("i32");
    const structural = arena.internStructuralObject({
      fields: [
        { name: "field10", type: i32 },
        { name: "field2", type: i32 },
        { name: "field1", type: i32 },
      ],
    });

    const desc = arena.get(structural);
    if (desc.kind !== "structural-object") {
      throw new Error(`expected structural object, got ${desc.kind}`);
    }
    expect(desc.fields.map((field) => field.name)).toEqual([
      "field1",
      "field2",
      "field10",
    ]);
  });

  it("invalidates contained type parameters when recursive placeholders resolve", () => {
    const arena = createTypeArena();
    const i32 = arena.internPrimitive("i32");
    const externalParam = arena.freshTypeParam();
    const externalRef = arena.internTypeParamRef(externalParam);
    const replacement = new Map([[externalParam, i32]]);
    const recursive = arena.createRecursiveType((self) => {
      expect(arena.substitute(self, replacement)).toBe(self);
      return {
        kind: "structural-object",
        fields: [
          { name: "next", type: self },
          { name: "value", type: externalRef },
        ],
      };
    });

    const substituted = arena.substitute(recursive, replacement);
    expect(substituted).not.toBe(recursive);
    const unfolded = arena.get(arena.unfoldRecursive(substituted));
    if (unfolded.kind !== "structural-object") {
      throw new Error(`expected structural object, got ${unfolded.kind}`);
    }
    expect(unfolded.fields.find((field) => field.name === "value")?.type).toBe(
      i32,
    );

    const recursiveDesc = arena.get(recursive);
    if (recursiveDesc.kind !== "recursive") {
      throw new Error(`expected recursive type, got ${recursiveDesc.kind}`);
    }
    expect(
      arena.substitute(
        recursive,
        new Map([[recursiveDesc.binder, i32]]),
      ),
    ).toBe(recursive);
  });

  it("substitutes and preserves trait components of intersections", () => {
    const arena = createTypeArena();
    const i32 = arena.internPrimitive("i32");
    const param = arena.freshTypeParam();
    const paramRef = arena.internTypeParamRef(param);
    const trait = arena.internTrait({
      owner: { moduleId: "test", symbol: 1 },
      name: "Container",
      typeArgs: [paramRef],
    });
    const intersection = arena.internIntersection({ traits: [trait] });

    const substituted = arena.substitute(intersection, new Map([[param, i32]]));
    const intersectionDesc = arena.get(substituted);
    if (intersectionDesc.kind !== "intersection") {
      throw new Error(`expected intersection, got ${intersectionDesc.kind}`);
    }
    expect(intersectionDesc.traits).toHaveLength(1);
    const traitDesc = arena.get(intersectionDesc.traits![0]!);
    if (traitDesc.kind !== "trait") {
      throw new Error(`expected trait, got ${traitDesc.kind}`);
    }
    expect(traitDesc.typeArgs).toEqual([i32]);
  });

  it("preserves recursion through intersection trait components", () => {
    const arena = createTypeArena();
    const recursive = arena.createRecursiveType((self) => {
      const trait = arena.internTrait({
        owner: { moduleId: "test", symbol: 1 },
        name: "Recursive",
        typeArgs: [self],
      });
      return { kind: "intersection", traits: [trait] };
    });

    const recursiveDesc = arena.get(recursive);
    expect(recursiveDesc.kind).toBe("recursive");
    const unfolded = arena.get(arena.unfoldRecursive(recursive));
    if (unfolded.kind !== "intersection") {
      throw new Error(`expected intersection, got ${unfolded.kind}`);
    }
    expect(unfolded.traits).toHaveLength(1);
    const traitDesc = arena.get(unfolded.traits![0]!);
    if (traitDesc.kind !== "trait") {
      throw new Error(`expected trait, got ${traitDesc.kind}`);
    }
    expect(traitDesc.typeArgs).toEqual([recursive]);
  });

  it("preserves recursive structural field documentation", () => {
    const arena = createTypeArena();
    const recursive = arena.createRecursiveType((self) => ({
      kind: "structural-object",
      fields: [
        {
          name: "next",
          type: self,
          documentation: "The next recursive value.",
        },
      ],
    }));

    const unfolded = arena.get(arena.unfoldRecursive(recursive));
    if (unfolded.kind !== "structural-object") {
      throw new Error(`expected structural object, got ${unfolded.kind}`);
    }
    expect(unfolded.fields[0]?.documentation).toBe(
      "The next recursive value.",
    );
  });

  it("keeps substitution stack-safe for deeply nested types", () => {
    const arena = createTypeArena();
    const i32 = arena.internPrimitive("i32");
    const param = arena.freshTypeParam();
    let nested = arena.internTypeParamRef(param);
    for (let depth = 0; depth < 20_000; depth += 1) {
      nested = arena.internFixedArray(nested);
    }

    expect(() => arena.substitute(nested, new Map([[param, i32]]))).not.toThrow();
  });

  it("invalidates contained type parameters for non-recursive placeholders", () => {
    const arena = createTypeArena();
    const i32 = arena.internPrimitive("i32");
    const param = arena.freshTypeParam();
    const paramRef = arena.internTypeParamRef(param);
    const replacement = new Map([[param, i32]]);
    let placeholder = -1;

    const canonical = arena.createRecursiveType((self) => {
      placeholder = self;
      expect(arena.substitute(self, replacement)).toBe(self);
      return {
        kind: "structural-object",
        fields: [{ name: "value", type: paramRef }],
      };
    });

    expect(canonical).not.toBe(placeholder);
    const substituted = arena.substitute(placeholder, replacement);
    const desc = arena.get(substituted);
    if (desc.kind !== "structural-object") {
      throw new Error(`expected structural object, got ${desc.kind}`);
    }
    expect(desc.fields[0]?.type).toBe(i32);
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
