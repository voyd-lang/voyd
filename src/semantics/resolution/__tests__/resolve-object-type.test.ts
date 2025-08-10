import { describe, expect, test } from "vitest";
import {
  Call,
  Identifier,
  List,
  ObjectType,
} from "../../../syntax-objects/index.js";
import { resolveObjectType } from "../resolve-object-type.js";

describe("resolveObjectType", () => {
  test("returns new instances on repeated resolution of non-generic types", () => {
    const inner = new ObjectType({ name: "Inner", value: [] });
    const obj = new ObjectType({
      name: "Outer",
      value: [{ name: "field", typeExpr: inner }],
    });

    const r1 = resolveObjectType(obj);
    const r2 = resolveObjectType(obj);

    expect(r1).not.toBe(obj);
    expect(r2).not.toBe(obj);
    expect(r1).not.toBe(r2);

    // Original object should remain unresolved
    expect(obj.fields[0].type).toBeUndefined();

    // Resolved objects should have field types
    expect(r1.fields[0].type).toBeDefined();
    expect(r2.fields[0].type).toBeDefined();
  });

  test("reuses generic instances for identical type arguments", () => {
    const T = Identifier.from("T");
    const vec = new ObjectType({
      name: "Vec",
      value: [{ name: "item", typeExpr: T }],
      typeParameters: [T],
    });

    const call = new Call({
      fnName: Identifier.from("Vec"),
      args: new List({ value: [] }),
      typeArgs: new List({ value: [new ObjectType({ name: "i32", value: [] })] }),
    });

    const r1 = resolveObjectType(vec, call);
    const r2 = resolveObjectType(vec, call);

    expect(r1).toBe(r2);
    expect(vec.typesResolved).toBeUndefined();
  });
});
