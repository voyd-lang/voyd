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

test("@operation attaches a stable operation id", (t) => {
  const effect = parseFirstForm(`eff Log
  @operation(id: "write-text")
  write(tail, value: String) -> void`);
  const body = effect.at(2);
  if (!isForm(body)) throw new Error("expected effect body");
  const operation = body.at(1);
  if (!isForm(operation)) throw new Error("expected operation");
  t.expect(operation.attributes?.operation).toEqual({ id: "write-text" });
});

test("@operation rejects unsafe ids", (t) => {
  t.expect(() => parse(`eff Log
  @operation(id: "write::text")
  write(tail, value: String) -> void`)).toThrow(/without '::'/);
});

test("@operation rejects non-effect-operation targets", (t) => {
  t.expect(() => parse(`@operation(id: "x")
fn value() -> i32 = 1`)).toThrow(/only annotate an effect operation/);
});
