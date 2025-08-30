import { describe, expect, test, vi } from "vitest";
import {
  Call,
  f32,
  Fn,
  i32,
  Identifier,
  Int,
  List,
  MockIdentifier,
  ObjectType,
  Parameter,
} from "../../../syntax-objects/index.js";
import { TraitType } from "../../../syntax-objects/types/trait.js";
import { Implementation } from "../../../syntax-objects/implementation.js";
import { getCallFn } from "../get-call-fn.js";

describe("getCallFn", () => {
  test("returns undefined for primitive function calls", () => {
    const fnName = new Identifier({ value: "if" });
    const call = new Call({ fnName, args: new List({}) });

    expect(getCallFn(call)).toBeUndefined();
  });

  test("returns undefined if no candidates match", () => {
    const fnName = new Identifier({ value: "nonPrimitive" });
    const call = new Call({ fnName, args: new List({}) });
    call.resolveFns = vi.fn().mockReturnValue([]);

    expect(getCallFn(call)).toBeUndefined();
    expect(call.resolveFns).toHaveBeenCalledWith(fnName);
  });

  test("returns the only matching candidate", () => {
    const paramLabel = new Identifier({ value: "arg1" });
    const candidate = new Fn({
      name: new Identifier({ value: "candidateFn" }),
      parameters: [new Parameter({ name: paramLabel, type: i32 })],
    });

    const fnName = new Identifier({ value: "nonPrimitive" });
    const call = new Call({
      fnName,
      args: new List({ value: [new Int({ value: 2 })] }),
    });
    call.resolveFns = vi.fn().mockReturnValue([candidate]);

    expect(getCallFn(call)).toBe(candidate);
  });

  test("returns the best matching candidate", () => {
    const paramLabel1 = new Identifier({ value: "arg1" });
    const paramLabel2 = new Identifier({ value: "arg2" });
    const fnName = new Identifier({ value: "hey" });

    const candidate1 = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: paramLabel1, type: f32 })],
    });

    const candidate2 = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: paramLabel2, type: i32 })],
    });

    const call = new Call({
      fnName,
      args: new List({
        value: [new Int({ value: 2 })],
      }),
    });
    call.resolveFns = vi.fn().mockReturnValue([candidate1, candidate2]);

    expect(getCallFn(call)).toBe(candidate2);
  });

  test("throws error for ambiguous matches", () => {
    const paramLabel1 = new Identifier({ value: "arg1" });
    const paramLabel2 = new Identifier({ value: "arg2" });
    const fnName = new Identifier({ value: "hi" });

    const candidate1 = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: paramLabel1, type: i32 })],
    });

    const candidate2 = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: paramLabel2, type: i32 })],
    });

    const call = new Call({
      fnName,
      args: new List({
        value: [new Int({ value: 2 })],
      }),
    });
    call.resolveFns = vi.fn().mockReturnValue([candidate1, candidate2]);

    expect(() => getCallFn(call)).toThrowError(
      /Ambiguous call hi\(i32\).*hi\(arg1: i32\).*hi\(arg2: i32\)/
    );
  });

  test("matches to the best function given an object hierarchy", () => {
    const pName = new Identifier({ value: "arg1" });
    const fnName = new Identifier({ value: "hi" });
    const vec = new ObjectType({ name: "Vec", value: [] });
    const point = new ObjectType({ name: "Vec", value: [], parentObj: vec });
    const pointy = new ObjectType({ name: "Vec", value: [], parentObj: vec });

    const objIdentifier = new MockIdentifier({ value: "hi", entity: pointy });

    const candidate1 = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: pName, type: point })],
    });

    const candidate2 = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: pName, type: pointy })],
    });

    const call = new Call({
      fnName,
      args: new List({
        value: [objIdentifier],
      }),
    });

    call.resolveFns = vi.fn().mockReturnValue([candidate1, candidate2]);

    expect(getCallFn(call)).toBe(candidate2);
  });

  test("subtypes are considered to overlap, and throws ambiguous error", () => {
    const pName = new Identifier({ value: "arg1" });
    const fnName = new Identifier({ value: "hi" });
    const vec = new ObjectType({ name: "Vec", value: [] });
    const point = new ObjectType({ name: "Vec", value: [], parentObj: vec });
    const pointy = new ObjectType({ name: "Vec", value: [], parentObj: vec });

    const objIdentifier = new MockIdentifier({ value: "hi", entity: pointy });

    const candidate1 = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: pName, type: point })],
    });

    const candidate2 = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: pName, type: vec })],
    });

    const candidate3 = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: pName, type: pointy })],
    });

    const call = new Call({
      fnName,
      args: new List({
        value: [objIdentifier],
      }),
    });

    call.resolveFns = vi
      .fn()
      .mockReturnValue([candidate1, candidate2, candidate3]);

    expect(() => getCallFn(call)).toThrowError(
      /Ambiguous call hi\(Vec\).*hi\(arg1: Vec\)/
    );
  });

  test("returns trait method for trait object calls", () => {
    const objType = new ObjectType({ name: "Obj", value: [] });
    const traitMethod = new Fn({
      name: new Identifier({ value: "run" }),
      parameters: [new Parameter({ name: new Identifier({ value: "self" }) })],
    });
    const trait = new TraitType({
      name: new Identifier({ value: "Runner" }),
      methods: [traitMethod],
    });
    const impl = new Implementation({
      typeParams: [],
      targetTypeExpr: new Identifier({ value: "Obj" }),
      body: new List({ value: [] }),
      traitExpr: new Identifier({ value: "Runner" }),
    });
    const implMethod = new Fn({
      name: new Identifier({ value: "run" }),
      parameters: [
        new Parameter({
          name: new Identifier({ value: "self" }),
          type: objType,
        }),
      ],
      parent: impl,
    });
    impl.targetType = objType;
    impl.trait = trait;
    impl.registerExport(implMethod);
    trait.implementations = [impl];

    const arg = new MockIdentifier({ value: "r", entity: trait });
    const call = new Call({
      fnName: new Identifier({ value: "run" }),
      args: new List({ value: [arg] }),
      fn: traitMethod,
    });

    expect(getCallFn(call)).toBe(traitMethod);
  });

  test("trait-object discovery stays lazy and does not resolve unrelated impls", () => {
    const traitMethod = new Fn({
      name: new Identifier({ value: "run" }),
      parameters: [new Parameter({ name: new Identifier({ value: "self" }) })],
    });
    const trait = new TraitType({
      name: new Identifier({ value: "Runner" }),
      methods: [traitMethod],
    });

    // impl for ObjA
    const objA = new ObjectType({ name: "ObjA", value: [] });
    const implA = new Implementation({
      typeParams: [],
      targetTypeExpr: new Identifier({ value: "ObjA" }),
      body: new List({ value: [] }),
      traitExpr: new Identifier({ value: "Runner" }),
    });
    const mA = new Fn({
      name: new Identifier({ value: "run" }),
      parameters: [
        new Parameter({ name: new Identifier({ value: "self" }), type: objA }),
      ],
      body: new List({ value: [] }),
      parent: implA,
    });
    implA.targetType = objA;
    implA.trait = trait;
    implA.registerExport(mA);

    // impl for ObjB (unrelated)
    const objB = new ObjectType({ name: "ObjB", value: [] });
    const implB = new Implementation({
      typeParams: [],
      targetTypeExpr: new Identifier({ value: "ObjB" }),
      body: new List({ value: [] }),
      traitExpr: new Identifier({ value: "Runner" }),
    });
    const mB = new Fn({
      name: new Identifier({ value: "run" }),
      parameters: [
        new Parameter({ name: new Identifier({ value: "self" }), type: objB }),
      ],
      body: new List({ value: [] }),
      parent: implB,
    });
    implB.targetType = objB;
    implB.trait = trait;
    implB.registerExport(mB);

    trait.implementations = [implA, implB];

    const arg = new MockIdentifier({ value: "r", entity: trait });
    const call = new Call({
      fnName: new Identifier({ value: "run" }),
      args: new List({ value: [arg] }),
      fn: traitMethod,
    });

    const selected = getCallFn(call);
    expect(selected).toBe(traitMethod);
    // Ensure we haven't resolved bodies of impl methods or impls themselves
    expect(mA.typesResolved).not.toBe(true);
    expect(mB.typesResolved).not.toBe(true);
    expect(implA.typesResolved).not.toBe(true);
    expect(implB.typesResolved).not.toBe(true);
  });

  test("lazy specialization: only selected generic fn resolves body", () => {
    const fnName = new Identifier({ value: "foo" });

    // Matching generic candidate: <T>(arg: T)
    const match = new Fn({
      name: fnName.clone(),
      typeParameters: [new Identifier({ value: "T" })],
      parameters: [
        new Parameter({
          name: new Identifier({ value: "arg" }),
          typeExpr: new Identifier({ value: "T" }),
        }),
      ],
      // dummy body
      body: new List({ value: [] }),
    });

    // Non-matching generic candidate: <T>(arr: Array<T>)
    const nonMatch = new Fn({
      name: fnName.clone(),
      typeParameters: [new Identifier({ value: "T" })],
      parameters: [
        new Parameter({
          name: new Identifier({ value: "arr" }),
          typeExpr: new Call({
            fnName: new Identifier({ value: "Array" }),
            args: new List({ value: [] }),
            typeArgs: new List({ value: [new Identifier({ value: "T" })] }),
          }),
        }),
      ],
      body: new List({ value: [] }),
    });

    const call = new Call({
      fnName: fnName.clone(),
      args: new List({ value: [new Int({ value: 42 })] }),
    });

    call.resolveFns = vi.fn().mockReturnValue([match, nonMatch]);

    const selected = getCallFn(call)!;
    expect(selected).toBeDefined();
    expect(selected.name.value).toBe("foo");
    // Winner resolves body (typesResolved true)
    expect(selected.typesResolved).toBe(true);
    // Non-matching generic should not have resolved its body
    expect(nonMatch.typesResolved).not.toBe(true);
  });
});
