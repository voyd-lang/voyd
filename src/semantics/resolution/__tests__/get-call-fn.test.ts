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

  test("throws error when overloads only differ by return type", () => {
    const label = new Identifier({ value: "arg1" });
    const fnName = new Identifier({ value: "hi" });

    const candidate1 = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: label, type: i32 })],
    });
    candidate1.returnType = i32;
    candidate1.annotatedReturnType = i32;

    const candidate2 = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: label, type: i32 })],
    });
    candidate2.returnType = f32;
    candidate2.annotatedReturnType = f32;

    const call = new Call({
      fnName,
      args: new List({ value: [new Int({ value: 2 })] }),
    });
    call.resolveFns = vi.fn().mockReturnValue([candidate1, candidate2]);

    expect(() => getCallFn(call)).toThrow(
      /Ambiguous call hi\(i32\).*hi\(arg1: i32\) -> i32.*hi\(arg1: i32\) -> f32/
    );
  });

  test("keeps ambiguity when ranked return types tie", () => {
    const label1 = new Identifier({ value: "arg1" });
    const label2 = new Identifier({ value: "arg2" });
    const fnName = new Identifier({ value: "hi" });

    const candidate1 = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: label1, type: i32 })],
    });
    candidate1.returnType = i32;
    candidate1.annotatedReturnType = i32;

    const candidate2 = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: label2, type: i32 })],
    });
    candidate2.returnType = i32;
    candidate2.annotatedReturnType = i32;

    const call = new Call({
      fnName,
      args: new List({ value: [new Int({ value: 2 })] }),
    });
    call.resolveFns = vi.fn().mockReturnValue([candidate1, candidate2]);
    call.getAttribute = vi.fn().mockReturnValue(i32);

    expect(() => getCallFn(call)).toThrow(
      /Ambiguous call hi\(i32\).*hi\(arg1: i32\) -> i32.*hi\(arg2: i32\) -> i32/
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
});
