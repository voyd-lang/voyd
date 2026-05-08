import { describe, expect, it } from "vitest";
import { createTypeArena } from "../type-arena.js";

describe("type arena", () => {
  it("preserves structural field access metadata when interning", () => {
    const arena = createTypeArena();
    const i32 = arena.internPrimitive("i32");
    const type = arena.internStructuralObject({
      fields: [
        {
          name: "value",
          type: i32,
          visibility: { level: "object" },
          owner: 42,
          packageId: "pkg-a",
        },
      ],
    });

    const desc = arena.get(type);
    expect(desc.kind).toBe("structural-object");
    if (desc.kind !== "structural-object") return;
    expect(desc.fields[0]).toMatchObject({
      name: "value",
      type: i32,
      optional: false,
      visibility: { level: "object" },
      owner: 42,
      packageId: "pkg-a",
    });
  });

  it("does not merge structural objects with different field access metadata", () => {
    const arena = createTypeArena();
    const i32 = arena.internPrimitive("i32");
    const privateShape = arena.internStructuralObject({
      fields: [
        {
          name: "value",
          type: i32,
          visibility: { level: "object" },
          owner: 1,
          packageId: "pkg-a",
        },
      ],
    });
    const publicShape = arena.internStructuralObject({
      fields: [
        {
          name: "value",
          type: i32,
          visibility: { level: "public", api: true },
          owner: 1,
          packageId: "pkg-a",
        },
      ],
    });

    expect(publicShape).not.toBe(privateShape);
  });

  it("collapses singleton unions to the only member", () => {
    const arena = createTypeArena();
    const i32 = arena.internPrimitive("i32");

    expect(arena.internUnion([i32])).toBe(i32);
    expect(arena.internUnion([i32, i32])).toBe(i32);
  });
});
