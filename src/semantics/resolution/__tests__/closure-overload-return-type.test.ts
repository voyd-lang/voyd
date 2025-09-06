import { describe, expect, test } from "vitest";
import {
  Call,
  Closure,
  Fn,
  FnType,
  Identifier,
  Int,
  List,
  Parameter,
  i32,
  i64,
} from "../../../syntax-objects/index.js";
import { getCallFn } from "../get-call-fn.js";

describe("getCallFn uses closure's actual return type for overloads", () => {
  test("selects overload matching the closure body return type", () => {
    const fnName = Identifier.from("apply");
    const paramA = new Parameter({
      name: Identifier.from("f"),
      type: new FnType({
        name: Identifier.from("fnA"),
        parameters: [new Parameter({ name: Identifier.from("x"), type: i32 })],
        returnType: i32,
      }),
    });
    const fnA = new Fn({ name: fnName.clone(), parameters: [paramA] });
    fnA.returnType = i32;

    const paramB = new Parameter({
      name: Identifier.from("f"),
      type: new FnType({
        name: Identifier.from("fnB"),
        parameters: [new Parameter({ name: Identifier.from("x"), type: i32 })],
        returnType: i64,
      }),
    });
    const fnB = new Fn({ name: fnName.clone(), parameters: [paramB] });
    fnB.returnType = i32;

    const closure = new Closure({
      parameters: [new Parameter({ name: Identifier.from("x") })],
      body: new Int({ value: 1 }),
    });
    const call = new Call({
      fnName: fnName.clone(),
      args: new List({ value: [closure] }),
    });

    expect(getCallFn(call, [fnA, fnB])).toBe(fnA);
  });
});
