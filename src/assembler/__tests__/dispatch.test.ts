import { describe, expect, test, vi } from "vitest";
import { builtinCallCompilers } from "../builtin-call-registry.js";
import { compile as compileCall } from "../compile-call.js";
import { Call } from "../../syntax-objects/call.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { List } from "../../syntax-objects/list.js";

const makeOpts = (expr: Call) => ({
  expr,
  mod: { nop: () => 0, br: () => 0 } as any,
  extensionHelpers: {} as any,
  fieldLookupHelpers: {} as any,
});

const makeCall = (name: string) =>
  new Call({ fnName: new Identifier({ value: name }), args: new List([]) });

describe("builtin call dispatch", () => {
  const builtins = [
    "quote",
    "=",
    "if",
    "export",
    "mod",
    "member-access",
    "while",
    "break",
    "FixedArray",
    "binaryen",
  ];

  for (const name of builtins) {
    test(`dispatches to compiler for ${name}`, () => {
      const stub = vi.fn().mockReturnValue(7);
      const original = builtinCallCompilers.get(name);
      builtinCallCompilers.set(name, stub);
      const expr = makeCall(name);
      const result = compileCall(makeOpts(expr));
      expect(result).toBe(7);
      expect(stub).toHaveBeenCalled();
      if (original) builtinCallCompilers.set(name, original);
      else builtinCallCompilers.delete(name);
    });
  }
});
