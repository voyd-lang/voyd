import { parse } from "../parser.js";
import { voidFile, voidFileWithGenerics } from "./fixtures/void-file.js";
import { test } from "vitest";

test("parser can parse a file into a syntax expanded ast", async (t) => {
  t.expect(parse(voidFile)).toMatchSnapshot();
});

test("parser supports generics", async (t) => {
  t.expect(parse(voidFileWithGenerics)).toMatchSnapshot();
});
