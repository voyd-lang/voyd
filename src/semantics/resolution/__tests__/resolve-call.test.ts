import { describe, expect, test, vi } from "vitest";
import {
  Call,
  Fn,
  Identifier,
  Int,
  List,
  MockIdentifier,
  Variable,
  i32,
} from "../../../syntax-objects/index.js";
import { TraitType } from "../../../syntax-objects/types/trait.js";
import { resolveCall } from "../resolve-call.js";
import * as getCallFnModule from "../get-call-fn.js";

describe("resolveCall", () => {
  test("uses trait method return type while still triggering candidate search", () => {
    const traitMethod = new Fn({
      name: Identifier.from("run"),
      parameters: [],
    });
    traitMethod.returnType = i32;
    const trait = new TraitType({
      name: Identifier.from("Run"),
      methods: [traitMethod],
    });

    const variable = new Variable({
      name: Identifier.from("r"),
      isMutable: false,
      initializer: new Int({ value: 0 }),
      type: trait,
    });

    const arg = new MockIdentifier({ value: "r", entity: variable });

    const call = new Call({
      fnName: Identifier.from("run"),
      args: new List({ value: [arg] }),
    });

    const implFn = new Fn({ name: Identifier.from("run"), parameters: [] });
    implFn.returnType = i32;

    const getCallFnSpy = vi
      .spyOn(getCallFnModule, "getCallFn")
      .mockReturnValue(implFn);

    resolveCall(call);

    expect(getCallFnSpy).toHaveBeenCalledOnce();
    expect(call.fn).toBe(traitMethod);
    expect(call.type).toBe(traitMethod.returnType);

    getCallFnSpy.mockRestore();
  });
});
