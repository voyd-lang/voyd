import { CharStream } from "../../char-stream.js";
import { read } from "../../reader.js";
import { interpretWhitespace } from "../interpret-whitespace.js";
import { expect, test } from "vitest";
import { expandSyntaxMacros } from "../index.js";

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

test("it does not merge adjacent suite calls into clause-sugar args", () => {
  const sink = new CharStream(
    [
      "foo bar:",
      "  hi()",
      "foo baz:",
      "  bye()",
    ].join("\n"),
    "test"
  );
  const readerOutput = read(sink);
  expect(expandSyntaxMacros(readerOutput, [interpretWhitespace]).toJSON()).toEqual([
    "ast",
    [
      "foo",
      "bar",
      ":",
      [
        "block",
        [
          "hi",
        ],
      ],
    ],
    [
      "foo",
      "baz",
      ":",
      [
        "block",
        [
          "bye",
        ],
      ],
    ],
  ]);
});
