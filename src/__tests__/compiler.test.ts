import { e2eVoidText } from "./fixtures/e2e-file.js";
import { compile } from "../compiler.js";
import { test } from "vitest";
import assert from "node:assert";

test("Compiler can compile and run a basic void program", async (t) => {
  const mod = await compile(e2eVoidText);
  const bin = mod.emitBinary();
  const compiled = new WebAssembly.Module(bin);
  const instance = new WebAssembly.Instance(compiled);

  const fn =
    typeof instance.exports.main === "function"
      ? instance.exports.main
      : undefined;

  assert(fn, "Function exists");
  t.expect(fn(), "Main function returns correct value").toEqual(55);
});
