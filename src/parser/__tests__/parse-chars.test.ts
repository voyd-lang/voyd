import { parseChars } from "../parse-chars.js";
import { voidFile } from "./fixtures/parse-text-void-file.js";
import { test } from "vitest";

test("should parse the example file into a raw ast", async ({ expect }) => {
  const parserOutput = parseChars(voidFile);
  expect(parserOutput).toMatchSnapshot();
});
