import { test } from "vitest";
import { isForm, parse } from "../index.js";

const parseFirstForm = (text: string) => {
  const ast = parse(text);
  const node = ast.rest[0];
  if (!isForm(node)) throw new Error("expected an object declaration");
  return node;
};

test("@host_transport attaches a static provider identity to an object", (t) => {
  const provider = parseFirstForm(`@host_transport(id: "example.transport", version: 2)
obj ExampleTransport {}`);

  t.expect(provider.attributes?.hostTransport).toEqual({
    id: "example.transport",
    version: 2,
  });
});

test("@host_transport requires a complete positive identity", (t) => {
  t.expect(() =>
    parse(`@host_transport(id: "example.transport", version: 0)
obj ExampleTransport {}`),
  ).toThrow(/positive integer/);
  t.expect(() =>
    parse(`@host_transport(id: "example.transport")
obj ExampleTransport {}`),
  ).toThrow(/requires id and version/);
  t.expect(() =>
    parse(`@host_transport(id: "example.transport", version: 1)
fn wrong() -> void
  void`),
  ).toThrow(/must precede an object/);
});
