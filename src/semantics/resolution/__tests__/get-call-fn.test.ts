import { describe, expect, test, vi, Mock } from "vitest";
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
      `Ambiguous call ${JSON.stringify(call, null, 2)}`
    );
  });

  test("matches to the best function given an object hierarchy", () => {
    const pName = new Identifier({ value: "arg1" });
    const fnName = new Identifier({ value: "hi" });
    const vec = new ObjectType({ name: "Vec", value: [] });
    const point = new ObjectType({ name: "Vec", value: [], parentObj: vec });
    const pointy = new ObjectType({ name: "Vec", value: [], parentObj: vec });

    const objIdentifier = new MockIdentifier({ value: "hi", entity: point });

    const candidate1 = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: pName, type: vec })],
    });

    const candidate2 = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: pName, type: point })],
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

    expect(getCallFn(call)).toBe(candidate2);
  });
});
