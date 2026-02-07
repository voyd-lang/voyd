import { describe, expect, it } from "vitest";
import {
  createEffectInterner,
  createEffectTable,
} from "../../effects/effect-table.js";
import { createTypeTranslation } from "../imports.js";
import {
  effectsShareInterner,
  typingContextsShareInterners,
} from "../shared-interners.js";
import { createTypeArena } from "../type-arena.js";

describe("shared interner checks", () => {
  it("treats effect tables backed by the same interner as shared", () => {
    const interner = createEffectInterner();
    const left = createEffectTable({ interner });
    const right = createEffectTable({ interner });
    const isolated = createEffectTable();

    expect(effectsShareInterner(left, right)).toBe(true);
    expect(effectsShareInterner(left, isolated)).toBe(false);
  });

  it("treats contexts as shared only when arena and effect interner match", () => {
    const sharedArena = createTypeArena();
    const otherArena = createTypeArena();
    const interner = createEffectInterner();
    const sourceEffects = createEffectTable({ interner });
    const targetEffects = createEffectTable({ interner });

    expect(
      typingContextsShareInterners({
        sourceArena: sharedArena,
        targetArena: sharedArena,
        sourceEffects,
        targetEffects,
      }),
    ).toBe(true);
    expect(
      typingContextsShareInterners({
        sourceArena: sharedArena,
        targetArena: otherArena,
        sourceEffects,
        targetEffects,
      }),
    ).toBe(false);
  });

  it("preserves recursive type identities across shared typing interners", () => {
    const arena = createTypeArena();
    const interner = createEffectInterner();
    const sourceEffects = createEffectTable({ interner });
    const targetEffects = createEffectTable({ interner });

    const i32 = arena.internPrimitive("i32");
    const recursive = arena.createRecursiveType((self) => ({
      kind: "union",
      members: [i32, self],
    }));

    const translate = createTypeTranslation({
      sourceArena: arena,
      targetArena: arena,
      sourceEffects,
      targetEffects,
      mapSymbol: (symbol) => symbol,
    });

    expect(translate(recursive)).toBe(recursive);
  });
});
