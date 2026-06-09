import { test } from "vitest";
import type { BoundaryAttribute } from "../attributes.js";
import { isForm, parse } from "../index.js";

const parseFirstForm = (text: string) => {
  const ast = parse(text);
  const node = ast.rest[0];
  if (!isForm(node)) {
    throw new Error("expected a declaration form");
  }
  return node;
};

test("@boundary attaches metadata to type aliases", (t) => {
  const alias = parseFirstForm(`@boundary(type: "value")
type Html = MsgPack`);

  t.expect(alias.attributes?.boundary as BoundaryAttribute | undefined).toEqual({
    type: "value",
  });
});

test("@boundary rejects unsupported target combinations", (t) => {
  t.expect(() =>
    parse(`@boundary(type: "payload", field: "payload")
type Cmd = MsgPack`),
  ).toThrow("@boundary on type aliases only supports type: \"value\"");

  t.expect(() =>
    parse(`@boundary(type: "value")
fn encode() -> i32
  0`),
  ).toThrow("@boundary does not apply to functions");
});

test("@boundary rejects fields outside payload envelopes", (t) => {
  t.expect(() =>
    parse(`@boundary(type: "value", field: "payload")
type Html = MsgPack`),
  ).toThrow("@boundary value does not accept a 'field:' argument");
});
