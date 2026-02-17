import { describe, expect, it } from "vitest";
import type { SymbolId } from "../../ids.js";
import { createEffectTable } from "../../effects/effect-table.js";
import { collectTraitOwnersFromTypeParams } from "../constraint-trait-owners.js";
import { createTypeArena } from "../type-arena.js";

describe("collectTraitOwnersFromTypeParams", () => {
  it("collects nested trait owners from constrained type parameters", () => {
    const effects = createEffectTable();
    const arena = createTypeArena();
    const bool = arena.internPrimitive("bool");

    const hashable = arena.internTrait({
      owner: { moduleId: "std::hash", symbol: 1 as SymbolId },
      name: "Hashable",
      typeArgs: [],
    });
    const key = arena.internTrait({
      owner: { moduleId: "std::dict", symbol: 2 as SymbolId },
      name: "Key",
      typeArgs: [hashable],
    });
    const shaped = arena.internTrait({
      owner: { moduleId: "app::shape", symbol: 3 as SymbolId },
      name: "Shaped",
      typeArgs: [],
    });

    const nestedConstraint = arena.internIntersection({
      traits: [key],
      structural: arena.internStructuralObject({
        fields: [
          {
            name: "validator",
            type: arena.internFunction({
              parameters: [{ type: arena.internUnion([key, bool]), optional: false }],
              returnType: arena.internFixedArray(shaped),
              effectRow: effects.emptyRow,
            }),
          },
        ],
      }),
    });

    const owners = collectTraitOwnersFromTypeParams({
      typeParams: [{ constraint: nestedConstraint }],
      arena,
    });

    expect(Array.from(owners.keys()).sort()).toEqual([
      "app::shape::3",
      "std::dict::2",
      "std::hash::1",
    ]);
  });

  it("returns an empty map when there are no constraints", () => {
    const arena = createTypeArena();
    const owners = collectTraitOwnersFromTypeParams({
      typeParams: [{}, { constraint: undefined }],
      arena,
    });
    expect(owners.size).toBe(0);
  });
});
