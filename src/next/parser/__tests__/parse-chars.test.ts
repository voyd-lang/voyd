import { parseChars } from "../parse-chars.js";
import { CharStream } from "../char-stream.js";
import { voydFile } from "./fixtures/parse-text-voyd-file.js";
import { test } from "vitest";

test("should parse the example file into a raw ast", async ({ expect }) => {
  const parserOutput = parseChars(voydFile);
  expect(parserOutput).toMatchSnapshot();
});

test("keeps angle bracket lexer state when parsing nested generics", ({
  expect,
}) => {
  const stream = new CharStream("Foo<Option<Result<int, int>>>", "test");
  const parsed = parseChars(stream);

  const json = JSON.parse(JSON.stringify(parsed));
  expect(json).toEqual([
    "ast",
    [
      "Foo",
      [
        "generics",
        "Option",
        ["generics", "Result", ["generics", "int", ",", " ", "int"]],
      ],
    ],
  ]);
});
