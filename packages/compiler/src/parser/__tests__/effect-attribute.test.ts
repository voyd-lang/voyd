import { test } from "vitest";
import { isForm, parse } from "../index.js";

const parseFirstForm = (text: string) => {
  const ast = parse(text);
  const form = ast.rest[0];
  if (!isForm(form)) {
    throw new Error("expected first form");
  }
  return form;
};

test("@effect attaches id metadata to effects", (t) => {
  const effect = parseFirstForm(`@effect(id: "com.example.log")
eff Log
  info`);
  t.expect(effect.attributes?.effect).toEqual({ id: "com.example.log" });
});

test("@effect rejects unknown labels", (t) => {
  t.expect(() =>
    parse(`@effect(name: "Log")
eff Log
  info`)
  ).toThrow(/unknown @effect argument/);
});

test("@effect rejects non-string ids", (t) => {
  t.expect(() =>
    parse(`@effect(id: 123)
eff Log
  info`)
  ).toThrow(/@effect id must be a string/);
});
