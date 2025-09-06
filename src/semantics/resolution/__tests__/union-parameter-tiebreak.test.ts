import { describe, test, expect, vi } from "vitest";
import {
  Call,
  Fn,
  Identifier,
  List,
  MockIdentifier,
  ObjectType,
  Parameter,
} from "../../../syntax-objects/index.js";
import { UnionType } from "../../../syntax-objects/types.js";
import { resolveUnionType } from "../resolve-union.js";
import { getCallFn } from "../get-call-fn.js";

describe("union-parameter tiebreak prefers union over member when self differs", () => {
  test("selects union-parameter overload when another differs by member type", () => {
    const fnName = new Identifier({ value: "push" });

    // Simulate two related Array object types where B extends A
    const arrayA = new ObjectType({ name: new Identifier({ value: "ArrayA" }), value: [] });
    const arrayB = new ObjectType({
      name: new Identifier({ value: "ArrayB" }),
      value: [],
      parentObj: arrayA,
    });

    // Value types: String, Map, ArrayMP and a union U = Map | ArrayMP | String
    const stringT = new ObjectType({ name: new Identifier({ value: "String" }), value: [] });
    const mapT = new ObjectType({ name: new Identifier({ value: "Map" }), value: [] });
    const arrayMpT = new ObjectType({ name: new Identifier({ value: "ArrayMP" }), value: [] });
    const union = new UnionType({
      name: new Identifier({ value: "U" }),
      childTypeExprs: [mapT, arrayMpT, stringT],
    });
    resolveUnionType(union);

    // Overload 1: push(self: ArrayA, value: U) -> ArrayB
    const u1 = new Fn({
      name: fnName.clone(),
      parameters: [
        new Parameter({ name: Identifier.from("self"), type: arrayA }),
        new Parameter({ name: Identifier.from("value"), type: union }),
      ],
    });
    u1.returnType = arrayB;
    u1.annotatedReturnType = arrayB;

    // Overload 2: push(self: ArrayB, value: String) -> ArrayB
    const u2 = new Fn({
      name: fnName.clone(),
      parameters: [
        new Parameter({ name: Identifier.from("self"), type: arrayB }),
        new Parameter({ name: Identifier.from("value"), type: stringT }),
      ],
    });
    u2.returnType = arrayB;
    u2.annotatedReturnType = arrayB;

    // Call: push(selfB, "str") — self: ArrayB; value: String
    const call = new Call({
      fnName: fnName.clone(),
      args: new List({
        value: [
          new MockIdentifier({ value: "selfB", entity: arrayB }),
          new MockIdentifier({ value: "str", entity: stringT }),
        ],
      }),
    });
    call.resolveFns = vi.fn().mockReturnValue([u1, u2]);

    // Before the fix this scenario could be ambiguous; now the union overload wins.
    const chosen = getCallFn(call);
    expect(chosen).toBe(u1);
  });
});

