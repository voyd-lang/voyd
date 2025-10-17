import { describe, expect, test } from "vitest";
import {
  ObjectType,
  UnionType,
  SelfType,
} from "../../../syntax-objects/index.js";
import { typesAreCompatible } from "../types-are-compatible.js";

describe("typesAreCompatible - unions", () => {
  test("handles large unions", () => {
    const objsA: ObjectType[] = [];
    const objsB: ObjectType[] = [];

    for (let i = 0; i < 100; i++) {
      const obj = new ObjectType({ name: `Obj${i}`, fields: [] });
      objsA.push(obj);
      objsB.push(obj);
    }
    // Add an extra type to B so that B is a superset of A
    objsB.push(new ObjectType({ name: "Extra", fields: [] }));

    const unionA = new UnionType({ name: "UnionA", childTypeExprs: [] });
    unionA.resolvedMemberTypes = objsA;

    const unionB = new UnionType({ name: "UnionB", childTypeExprs: [] });
    unionB.resolvedMemberTypes = objsB;

    expect(typesAreCompatible(unionA, unionB)).toBe(true);
    expect(typesAreCompatible(unionB, unionA)).toBe(false);
  });

  test("handles cyclic unions", () => {
    const a = new ObjectType({ name: "A", fields: [] });
    const b = new ObjectType({ name: "B", fields: [] });

    const u1 = new UnionType({ name: "U1", childTypeExprs: [] });
    const u2 = new UnionType({ name: "U2", childTypeExprs: [] });

    u1.resolvedMemberTypes = [a, u2];
    u2.resolvedMemberTypes = [b, u1];

    expect(typesAreCompatible(u1, u2)).toBe(true);
  });

  test("handles deeply nested unions", () => {
    const depth = 200;
    let current = new UnionType({ name: `U${depth}`, childTypeExprs: [] });
    current.resolvedMemberTypes = [
      new ObjectType({ name: `Obj${depth}`, fields: [] }),
    ];
    for (let i = depth - 1; i >= 0; i--) {
      const next = new UnionType({ name: `U${i}`, childTypeExprs: [] });
      const obj = new ObjectType({ name: `Obj${i}`, fields: [] });
      next.resolvedMemberTypes = [obj, current];
      current = next;
    }

    expect(typesAreCompatible(current, current)).toBe(true);
  });

  test("considers self types compatible", () => {
    expect(typesAreCompatible(new SelfType(), new SelfType())).toBe(true);
  });
});
