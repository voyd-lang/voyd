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

