import { describe, expect, test } from "vitest";
import {
  ObjectType,
  UnionType,
  SelfType,
  PrimitiveType,
} from "../../../syntax-objects/index.js";
import { typesAreCompatible } from "../types-are-compatible.js";

describe("typesAreCompatible - unions", () => {
  test("handles large unions", () => {
    const objsA: ObjectType[] = [];
    const objsB: ObjectType[] = [];

    for (let i = 0; i < 100; i++) {
      const obj = new ObjectType({ name: `Obj${i}`, value: [] });
      objsA.push(obj);
      objsB.push(obj);
    }
    // Add an extra type to B so that B is a superset of A
    objsB.push(new ObjectType({ name: "Extra", value: [] }));

    const unionA = new UnionType({ name: "UnionA", childTypeExprs: [] });
    unionA.types = objsA;

    const unionB = new UnionType({ name: "UnionB", childTypeExprs: [] });
    unionB.types = objsB;

    expect(typesAreCompatible(unionA, unionB)).toBe(true);
    expect(typesAreCompatible(unionB, unionA)).toBe(false);
  });

  test("handles cyclic unions", () => {
    const a = new ObjectType({ name: "A", value: [] });
    const b = new ObjectType({ name: "B", value: [] });

    const u1 = new UnionType({ name: "U1", childTypeExprs: [] });
    const u2 = new UnionType({ name: "U2", childTypeExprs: [] });

    u1.types = [a, u2];
    u2.types = [b, u1];

    expect(typesAreCompatible(u1, u2)).toBe(true);
  });

  test("handles deeply nested unions", () => {
    const depth = 200;
    let current = new UnionType({ name: `U${depth}`, childTypeExprs: [] });
    current.types = [new ObjectType({ name: `Obj${depth}`, value: [] })];
    for (let i = depth - 1; i >= 0; i--) {
      const next = new UnionType({ name: `U${i}`, childTypeExprs: [] });
      const obj = new ObjectType({ name: `Obj${i}`, value: [] });
      next.types = [obj, current];
      current = next;
    }

    expect(typesAreCompatible(current, current)).toBe(true);
  });

  test("considers self types compatible", () => {
    expect(typesAreCompatible(new SelfType(), new SelfType())).toBe(true);
  });

  test("handles primitives within unions", () => {
    const strOrNum = new UnionType({ name: "StrOrNum", childTypeExprs: [] });
    const str = PrimitiveType.from("string");
    const num = PrimitiveType.from("i32");
    strOrNum.types = [str, num];

    expect(typesAreCompatible(str, strOrNum)).toBe(true);
    const bool = PrimitiveType.from("bool");
    const boolOrNum = new UnionType({ name: "BoolOrNum", childTypeExprs: [] });
    boolOrNum.types = [bool, num];
    expect(typesAreCompatible(str, boolOrNum)).toBe(false);
  });
});
