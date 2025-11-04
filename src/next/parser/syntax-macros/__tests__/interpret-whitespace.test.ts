import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CharStream } from "../../char-stream.js";
import { read } from "../../reader.js";
import { expandSyntaxMacros } from "../index.js";
import { functionalNotation } from "../functional-notation.js";
import { interpretWhitespace } from "../interpret-whitespace.js";
import { expect, test } from "vitest";

const runFixture = async (name: string) => {
  const path = resolve(import.meta.dirname, "__fixtures__", name);
  const file = await readFile(path, { encoding: "utf-8" });
  const chars = new CharStream(file, path);
  const readerOutput = read(chars);
  return expandSyntaxMacros(readerOutput, [
    functionalNotation,
    interpretWhitespace,
  ]);
};

test("it correctly inserts blocks in a basic fib fn", async () => {
  const form = await runFixture("fib.voyd");
  expect(form).toMatchSnapshot();
});

test("it correctly passes inline closure parameters", async () => {
  const form = await runFixture("closure_params.voyd");
  expect(form).toMatchSnapshot();
});

test("it correctly handles implicit labeled arguments to a generic function", async () => {
  const form = await runFixture("generics_with_labels.voyd");
  expect(form).toMatchSnapshot();
});
