import { describe, test, expect, beforeEach, afterEach } from "vitest";
import { ObjectLiteral, Int } from "../../../syntax-objects/index.js";
import { resolveEntities } from "../resolve-entities.js";

const withEnv = (key: string, value: string | undefined, fn: () => void) => {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
};

describe("VOYD_CANON_STRUCT gating", () => {
  test("off: structural field typeExpr remains initializer (ObjectLiteral)", () => {
    withEnv("VOYD_CANON_STRUCT", undefined, () => {
      const inner = new ObjectLiteral({ fields: [{ name: "a", initializer: new Int({ value: 1 }) }] });
      const outer = new ObjectLiteral({
        fields: [{ name: "inner", initializer: inner }],
      });
      const resolved = resolveEntities(outer) as ObjectLiteral;
      const ty = resolved.type!;
      const field = ty.getField("inner")!;
      // Without gating, typeExpr is the initializer (ObjectLiteral)
      expect(field.typeExpr.isObjectLiteral()).toBe(true);
    });
  });

  test("on: structural field typeExpr is canonical structural type expr", () => {
    withEnv("VOYD_CANON_STRUCT", "1", () => {
      const inner = new ObjectLiteral({ fields: [{ name: "a", initializer: new Int({ value: 1 }) }] });
      const outer = new ObjectLiteral({
        fields: [{ name: "inner", initializer: inner }],
      });
      const resolved = resolveEntities(outer) as ObjectLiteral;
      const ty = resolved.type!;
      const field = ty.getField("inner")!;
      // With gating, we should have canonical structural ObjectType expr
      expect(field.typeExpr.isObjectType()).toBe(true);
      expect(field.typeExpr.isObjectLiteral?.()).not.toBe(true);
    });
  });
});
