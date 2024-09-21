import { parse } from "../parser.js";
import { voydFile, voydFileWithGenerics } from "./fixtures/voyd-file.js";
import { test } from "vitest";

test("parser can parse a file into a syntax expanded ast", async (t) => {
  t.expect(parse(voydFile)).toMatchSnapshot();
});

test("parser supports generics", async (t) => {
  t.expect(parse(voydFileWithGenerics)).toMatchSnapshot();
});
