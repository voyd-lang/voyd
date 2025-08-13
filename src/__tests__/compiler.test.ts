import {
  e2eVoydText,
  kitchenSink,
  goodTypeInferenceText,
  tcoText,
} from "./fixtures/e2e-file.js";
import { compile } from "../compiler.js";
import { describe, test, vi } from "vitest";
import assert from "node:assert";
import { getWasmFn, getWasmInstance } from "../lib/wasm.js";
import * as rCallUtil from "../assembler/return-call.js";
import { readString } from "../lib/read-string.js";
import { compilers } from "../assembler.js";

describe("E2E Compiler Pipeline", () => {
  test("Compiler can compile and run a basic voyd program", async (t) => {
    const mod = await compile(e2eVoydText);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "Main function returns correct value").toEqual(55);
  });

  test("Compiler has good inference", async (t) => {
    const mod = await compile(goodTypeInferenceText);
    const instance = getWasmInstance(mod);
    const fn = getWasmFn("main", instance);
    assert(fn, "Function exists");
    t.expect(fn(), "Main function returns correct value").toEqual(55n);
  });

  test("Compiler kitchen sink", async (t) => {
    const mod = await compile(kitchenSink);
    const instance = getWasmInstance(mod);
    t.expect(mod.validate(), "Module is valid");
    const tests = (expectedValues: unknown[]) =>
      expectedValues.forEach((v, i) => {
        const test = getWasmFn(`test${i + 1}`, instance);
        assert(test, `Test${i + 1} exists`);

        if (typeof v === "string") {
          t.expect(
            readString(test(), instance),
            `test ${i + 1} returns correct value`
          ).toEqual(v);
          return;
        }

        t.expect(test(), `test ${i + 1} returns correct value`).toEqual(v);
      });

    tests([
      13, // Static method resolution tests
      1,
      2,
      52,
      52, // Match based type narrowing (and basic gc)
      21,
      -1,
      143, // Generic type test
      7.5, // Generic object type test
      12,
      4,
      597, // Modules
      9, // Generic impls
      17,
      82,
      3,
      42,
      2, // IntersectionType tests
      20, // While loop
      "Hello, world! This is a test.",
      12, // Array  of objects test + advanced match
      173, // Array test
      4, // Structural object re-assignment
      "world",
      8, // trait impls
      7, // Recursive heap object type match Some
      -1, // Recursive heap object type match None
      5, // Inferred generic object type parameter
      1, // Trait parameter type
      2, // Tuple literal
    ]);

    const expectedSyntaxTypes = [
      "call",
      "block",
      "match",
      "int",
      "string-literal",
      "float",
      "identifier",
      "fn",
      "variable",
      "module",
      "object-literal",
      "type",
    ];
    t.expect(Object.keys(compilers)).toEqual(
      t.expect.arrayContaining(expectedSyntaxTypes)
    );
  });

  test("Compiler can do tco", async (t) => {
    const spy = vi.spyOn(rCallUtil, "returnCall");
    await compile(tcoText);
    const did = spy.mock.calls.some((call) => call[1].startsWith("fib"));
    t.expect(did);
  });
});
