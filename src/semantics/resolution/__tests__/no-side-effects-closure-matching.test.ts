import { describe, test, expect } from "vitest";
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
} from "../../../syntax-objects/index.js";
import { getCallFn } from "../get-call-fn.js";
describe("getCallFn closure matching does not mutate call args", () => {
  test("does not stamp types onto an untyped closure param while probing candidates", () => {
    const fnName = Identifier.from("apply");
    // Overload A: second param expects (String) -> i32
    const aParam1 = new Parameter({ name: Identifier.from("a"), type: i32 });
    const aParam2 = new Parameter({ name: Identifier.from("f") });
    const aFn = new Fn({
      name: fnName.clone(),
      parameters: [aParam1, aParam2],
    });
    aParam2.type = new FnType({
      name: Identifier.from("fnA"),
      parameters: [new Parameter({ name: Identifier.from("s") })],
      returnType: i32,
    });
    aFn.returnType = i32;
    // Overload B: second param expects (i32) -> i32
    const bParam1 = new Parameter({ name: Identifier.from("a"), type: i32 });
    const bParam2 = new Parameter({ name: Identifier.from("f") });
    const bFn = new Fn({
      name: fnName.clone(),
      parameters: [bParam1, bParam2],
    });
    bParam2.type = new FnType({
      name: Identifier.from("fnB"),
      parameters: [new Parameter({ name: Identifier.from("n"), type: i32 })],
      returnType: i32,
    });
    bFn.returnType = i32;
    // Call: apply(1, x => 1) — closure param is intentionally untyped
    const untypedParam = new Parameter({ name: Identifier.from("x") });
    const closure = new Closure({
      parameters: [untypedParam],
      body: new Int({ value: 1 }),
    });
    const call = new Call({
      fnName: fnName.clone(),
      args: new List({ value: [new Int({ value: 1 }), closure] }),
    });
    // Sanity: closure param starts untyped
    expect(closure.parameters[0]?.type).toBeUndefined();
    // Probe candidates. Pre-fix, this mutated the original closure param type.
    try {
      getCallFn(call, [aFn, bFn]);
    } catch {
      // Ambiguity or other errors are fine; we're asserting lack of mutation.
    }
    // Ensure original closure parameter remains untyped (no side effects)
    expect(closure.parameters[0]?.type).toBeUndefined();
  });
});
