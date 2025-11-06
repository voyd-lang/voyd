import { test } from "vitest";
import { parse } from "../parser.js";
import { resolve } from "path";
import { readFile } from "fs/promises";

const runFixture = async (name: string) => {
  const path = resolve(import.meta.dirname, "fixtures", name);
  const text = await readFile(path, { encoding: "utf8" });
  return parse(text);
};

test("parser can parse a file into a syntax expanded ast", async (t) => {
  t.expect(await runFixture("sink.voyd")).toMatchSnapshot();
});

test("parser supports generics", async (t) => {
  t.expect(await runFixture("generics.voyd")).toMatchSnapshot();
});
