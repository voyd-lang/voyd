import { parse } from "../parser.js";
import { test } from "vitest";

const toPlain = (code: string) =>
  JSON.parse(JSON.stringify(parse(code).toJSON())) as unknown;

const findFirstCall = (
  root: unknown,
  head: string,
): unknown[] | undefined => {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    if (Array.isArray(current)) {
      if (current[0] === head) {
        return current as unknown[];
      }
      current.forEach((child) => stack.push(child));
      continue;
    }

    if (current && typeof current === "object") {
      Object.values(current as Record<string, unknown>).forEach((child) =>
        stack.push(child),
      );
    }
  }
  return undefined;
};

const containsNode = (root: unknown, expected: unknown): boolean =>
  JSON.stringify(root).includes(JSON.stringify(expected));

test("parses lambdas inside HTML interpolation expressions", (t) => {
  const code = `
use std::all
use std::vx::all
use std::msgpack::MsgPack

pub fn main() -> MsgPack
  let value: Array<String> = ["a", "b"]
  <ul>
    {value.map(f => <li style="line-height: 1.6;">{f}</li>)}
  </ul>
`;

  const ast = toPlain(code);
  const lambda = findFirstCall(ast, "=>");
  t.expect(lambda).toBeDefined();
  if (!lambda) return;
  t.expect(lambda.length).toBe(3);
  t.expect(lambda[1]).toBe("f");
});

test("lowers built-in HTML elements to VX constructors", (t) => {
  const code = `
use std::all
use std::vx::all

pub fn main()
  <button class="primary" disabled on_click={7}>Save</button>
`;

  const ast = toPlain(code);
  t.expect(findFirstCall(ast, "element")).toBeDefined();
  t.expect(findFirstCall(ast, "create_element")).toBeUndefined();
  t.expect(findFirstCall(ast, "class")).toBeDefined();
  t.expect(findFirstCall(ast, "disabled")).toBeDefined();
  t.expect(findFirstCall(ast, "event_message")).toBeDefined();
  t.expect(findFirstCall(ast, "event_handler")).toBeUndefined();
});

test("lowers closure-valued HTML events to retained VX event helpers", (t) => {
  const code = `
use std::msgpack
use std::msgpack::MsgPack
use std::vx::all

fn clicked(payload: MsgPack) -> MsgPack
  payload

pub fn main() -> MsgPack
  <button on_click={(payload: MsgPack) -> MsgPack => clicked(payload)}>Click</button>
`;

  const ast = toPlain(code);
  t.expect(findFirstCall(ast, "event_payload_handler")).toBeDefined();
  t.expect(findFirstCall(ast, "event_handler")).toBeUndefined();
  t.expect(findFirstCall(ast, "event_message")).toBeUndefined();
});

test("lowers non-click HTML event values to message and payload helpers", (t) => {
  const code = `
use std::msgpack
use std::msgpack::MsgPack
use std::vx::all

pub fn main() -> MsgPack
  <form on_submit={msgpack::make_string("save")}>
    <input on_input={(payload: MsgPack) -> MsgPack => payload} />
  </form>
`;

  const ast = toPlain(code);
  t.expect(findFirstCall(ast, "event_message")).toBeDefined();
  t.expect(findFirstCall(ast, "event_handler")).toBeUndefined();
  t.expect(findFirstCall(ast, "event_payload_handler")).toBeDefined();
});

test("lowers empty built-in HTML children to a typed MsgPack array", (t) => {
  const code = `
use std::array::Array
use std::msgpack::MsgPack
use std::vx::all

pub fn main() -> MsgPack
  <form>
    <input type="text" />
    <button></button>
  </form>
`;

  const ast = toPlain(code);
  t.expect(containsNode(ast, [
    "::",
    ["Array", ["generics", "MsgPack"]],
    ["init"],
  ])).toBe(true);
});
