import { test } from "vitest";
import { isForm, parse } from "../index.js";

const parseFirstForm = (text: string) => {
  const ast = parse(text);
  const node = ast.rest[0];
  if (!isForm(node)) throw new Error("expected an impl declaration");
  return node;
};

test("@compiler_impl attaches a stable identity to an impl", (t) => {
  const implementation =
    parseFirstForm(`@compiler_impl(id: "example.transport", version: 2)
impl ExampleProvider<Input, Output> for ExampleTransport
  fn transform(value: Input) -> Output
    value`);

  t.expect(implementation.attributes?.compilerImplementation).toEqual({
    id: "example.transport",
    version: 2,
  });
});

test("@compiler_impl requires a complete positive identity and an impl target", (t) => {
  t.expect(() =>
    parse(`@compiler_impl(id: "example.transport", version: 0)
impl ExampleProvider for ExampleTransport
  fn transform(value: Input) -> Output
    value`),
  ).toThrow(/positive integer/);
  t.expect(() =>
    parse(`@compiler_impl(id: "example.transport")
impl ExampleProvider for ExampleTransport
  fn transform(value: Input) -> Output
    value`),
  ).toThrow(/requires id and version/);
  t.expect(() =>
    parse(`@compiler_impl(id: "example.transport", version: 1)
fn wrong() -> void
  void`),
  ).toThrow(/must precede an impl/);
});

test("removed @host_transport metadata is no longer attached", (t) => {
  const ast = parse(`@host_transport(id: "example.transport", version: 1)
obj ExampleTransport {}`);
  const provider = ast.rest[1];
  if (!isForm(provider)) throw new Error("expected an object declaration");
  t.expect(provider.attributes?.hostTransport).toBeUndefined();
});
