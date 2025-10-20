import { parseChars } from "../parse-chars.js";
import { voydFile } from "./fixtures/parse-text-voyd-file.js";
import { test } from "vitest";

test("should parse the example file into a raw ast", async ({ expect }) => {
  const parserOutput = parseChars(voydFile);
  expect(parserOutput).toMatchSnapshot();
});
