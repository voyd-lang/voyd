import { describe, expect, it } from "vitest";
import type { NodeId, SymbolId, TypeId } from "../../ids.js";
import { createTypeArena } from "../type-arena.js";

const DUMMY_NODE: NodeId = 0;

describe("unification options", () => {
  it("projects types through the structuralResolver when comparing intersections", () => {
    const arena = createTypeArena();
    const bool = arena.internPrimitive("bool");
    const structural = arena.internStructuralObject({
      fields: [{ name: "value", type: bool }],
    });
    const nominal = arena.internNominalObject({
      owner: { moduleId: "test", symbol: 1 as SymbolId },
      name: "Widget",
      typeArgs: [],
    });
    const expected = arena.internIntersection({ nominal, structural });

    const observed = new Set<TypeId>();
    const result = arena.unify(structural, expected, {
      location: DUMMY_NODE,
      reason: "structural projection",
      variance: "covariant",
      allowUnknown: false,
      structuralResolver: (type) => {
        observed.add(type);
        if (type === expected) {
          return structural;
        }
        return type;
      },
    });

    expect(result.ok).toBe(true);
    expect(observed.has(expected)).toBe(true);
  });

  it("rejects unification when the structuralResolver declines to project", () => {
    const arena = createTypeArena();
    const bool = arena.internPrimitive("bool");
    const structural = arena.internStructuralObject({
      fields: [{ name: "value", type: bool }],
    });
    const nominal = arena.internNominalObject({
      owner: { moduleId: "test", symbol: 2 as SymbolId },
      name: "Gadget",
      typeArgs: [],
    });
    const expected = arena.internIntersection({ nominal, structural });

    let resolverInvocations = 0;
    const result = arena.unify(structural, expected, {
      location: DUMMY_NODE,
      reason: "projection declined",
      variance: "covariant",
      allowUnknown: false,
      structuralResolver: (type) => {
        resolverInvocations += 1;
        if (type === expected) {
          return undefined;
        }
        return type;
      },
    });

    expect(resolverInvocations).toBeGreaterThan(0);
    expect(result.ok).toBe(false);
  });

  it("honors allowUnknown when resolving unions containing unknown", () => {
    const arena = createTypeArena();
    const bool = arena.internPrimitive("bool");
    const unknown = arena.internPrimitive("unknown");
    const union = arena.internUnion([unknown, bool]);

    const relaxed = arena.unify(union, bool, {
      location: DUMMY_NODE,
      reason: "relaxed unknown",
      variance: "covariant",
      allowUnknown: true,
    });
    expect(relaxed.ok).toBe(true);

    const strict = arena.unify(union, bool, {
      location: DUMMY_NODE,
      reason: "strict unknown",
      variance: "covariant",
      allowUnknown: false,
    });
    expect(strict.ok).toBe(false);
  });
});
