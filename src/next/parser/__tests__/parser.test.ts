import { test } from "vitest";
import { parse } from "../parser.js";
import { voydFile, voydFileWithGenerics } from "./fixtures/voyd-file.js";

test("parser can parse a file into a syntax expanded ast", async (t) => {
  t.expect(parse(voydFile).toJSON()).toMatchSnapshot();
});

test("parser supports generics", async (t) => {
  t.expect(parse(voydFileWithGenerics)).toMatchSnapshot();
});
