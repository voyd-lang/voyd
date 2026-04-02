import { read } from "../reader.js";
import { CharStream } from "../char-stream.js";
import { voydFile } from "./fixtures/parse-text-voyd-file.js";
import { test } from "vitest";

test("should parse the example file into a raw ast", async ({ expect }) => {
  const parserOutput = read(voydFile);
  expect(parserOutput).toMatchSnapshot();
});

test("keeps angle bracket lexer state when parsing nested generics", ({
  expect,
}) => {
  const stream = new CharStream("Foo<Option<Result<int, int>>>", "test");
  const parsed = read(stream);

  const json = JSON.parse(JSON.stringify(parsed));
  expect(json).toEqual([
    "ast",
    "Foo",
    [
      "generics",
      ["Option", ["generics", ["Result", ["generics", "int", [" ", "int"]]]]],
    ],
  ]);
});

test("parses very large top-level forms without using variadic construction", ({
  expect,
}) => {
  const source = Array.from({ length: 150_000 }, (_, index) => `v${index}`).join(
    "\n"
  );

  const parsed = read(new CharStream(source, "large.voyd"));

  expect(parsed.length).toBeGreaterThan(150_000);
  expect(parsed.first?.toJSON()).toBe("ast");
  expect(parsed.last?.toJSON()).toBe("v149999");
});
