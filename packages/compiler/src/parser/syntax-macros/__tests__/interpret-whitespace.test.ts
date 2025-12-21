import { resolve } from "node:path";
import { CharStream } from "../../char-stream.js";
import { read } from "../../reader.js";
import { interpretWhitespace } from "../interpret-whitespace.js";
import { expect, test } from "vitest";
import { expandSyntaxMacros } from "../index.js";
import { readVoyd } from "../../lib/read-voyd.js";

const runFixture = async (name: string) => {
  const path = resolve(import.meta.dirname, "__fixtures__", name);
  const readerOutput = await readVoyd(path);
  return expandSyntaxMacros(readerOutput, [interpretWhitespace]);
};

test("it normalizes function calls", async ({ expect }) => {
  const sink = new CharStream(
    "fib(n - 1, hi)\nfib((n - 1, hi))\nfib<i32>(n - 1, hi)\nfib<i32>((n - 1, hi))\n(n - 1)\n(n - 1, hi)\nfib (n - 1)\nfib (n - 1, 4)",
    "test"
  );
  const readerOutput = read(sink);
  expect(
    expandSyntaxMacros(readerOutput, [interpretWhitespace])
  ).toMatchSnapshot();
});

test("it hoists trailing blocks for non-fn calls", () => {
  const sink = new CharStream(
    "foo(x: i32) -> None | Some\n  body()",
    "test"
  );
  const readerOutput = read(sink);
  expect(expandSyntaxMacros(readerOutput, [interpretWhitespace]).toJSON()).toEqual([
    "ast",
    [
      "foo",
      [
        "x",
        ":",
        "i32",
      ],
    ],
    "->",
    "None",
    "|",
    "Some",
    [
      "block",
      [
        "body",
      ],
    ],
  ]);
});

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

test("it correctly handles the kitchen sink", async () => {
  const form = await runFixture("sink.voyd");
  expect(form).toMatchSnapshot();
});

test("it supports clause-style labeled suites (multiline only)", () => {
  const sink = new CharStream(
    [
      "if x < 1 then:",
      "  10",
      "elif x < 2:",
      "  20",
      "else:",
      "  30",
    ].join("\n"),
    "test"
  );
  const readerOutput = read(sink);
  expect(expandSyntaxMacros(readerOutput, [interpretWhitespace]).toJSON()).toEqual([
    "ast",
    [
      "if",
      "x",
      "<",
      "1",
      "then",
      ":",
      [
        "block",
        "10",
      ],
      [
        "elif",
        ":",
        [
          "x",
          "<",
          "2",
        ],
      ],
      [
        "then",
        ":",
        [
          "block",
          "20",
        ],
      ],
      [
        "else",
        ":",
        [
          "block",
          "30",
        ],
      ],
    ],
  ]);
});
