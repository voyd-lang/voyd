import { read } from "../../reader.js";
import { voydFile } from "../../__tests__/fixtures/parse-text-voyd-file.js";
import { test } from "vitest";
import { functionalNotation } from "../functional-notation.js";
import { CharStream } from "../../char-stream.js";

test("should parse the example file into a raw ast", async ({ expect }) => {
  const readerOutput = read(voydFile);
  expect(functionalNotation(readerOutput)).toMatchSnapshot();
});

test("kitchen sink", async ({ expect }) => {
  const sink = new CharStream(
    "fib(n - 1, hi)\nfib((n - 1, hi))\nfib<i32>(n - 1, hi)\nfib<i32>((n - 1, hi))\n(n - 1)\n(n - 1, hi)\nfib (n - 1)\nfib (n - 1, 4)",
    "test"
  );
  const readerOutput = read(sink);
  expect(functionalNotation(readerOutput)).toMatchSnapshot();
});
