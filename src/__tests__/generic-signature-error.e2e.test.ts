import { describe, test } from "vitest";
import { compile } from "../compiler.js";

const badGenericVoyd = `
use std::all

fn bad<T>(x: Array<(string, T)>) -> i32
  0
`;

describe("Generic signature error reporting", () => {
  test("reports unknown type names inside generic param types", async (t) => {
    await t.expect(compile(badGenericVoyd)).rejects.toThrow(/Unrecognized identifier|Expected type/);
  });
});

