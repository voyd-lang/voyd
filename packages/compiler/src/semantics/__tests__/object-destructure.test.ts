import { initEntities } from "../init-entities.js";
import { List, Identifier, Block, Call, Variable } from "../../syntax-objects/index.js";
import { test } from "vitest";

test("initEntities handles object destructuring", (t) => {
  const expr = new List([
    "define",
    new List([
      "object",
      Identifier.from("x"),
      new List([":", Identifier.from("y"), Identifier.from("hello")]),
      Identifier.from("z"),
    ]),
    new List([
      "object",
      new List([":", Identifier.from("x"), 1]),
      new List([":", Identifier.from("y"), 2]),
      new List([":", Identifier.from("z"), 3]),
    ]),
  ]);
  const result = initEntities(expr);
  t.expect(result.isBlock && result.isBlock()).toBe(true);
  const block = result as Block;
  const vars = block.body as Variable[];
  t.expect(vars.map((v) => v.name.value)).toEqual(["x", "hello", "z"]);
  t.expect(vars.map((v) => (v.initializer as Call).fnName.value)).toEqual([
    "x",
    "y",
    "z",
  ]);
});
