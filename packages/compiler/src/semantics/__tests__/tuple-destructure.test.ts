import { initEntities } from "../init-entities.js";
import { List, Identifier, Block, Call, Variable } from "../../syntax-objects/index.js";
import { test } from "vitest";

test("initEntities handles tuple destructuring", (t) => {
  const expr = new List([
    "define",
    new List(["tuple", Identifier.from("a"), Identifier.from("b"), Identifier.from("c")]),
    new List(["tuple", 1, 2, 3]),
  ]);
  const result = initEntities(expr);
  t.expect(result.isBlock && result.isBlock()).toBe(true);
  const block = result as Block;
  const vars = block.body as Variable[];
  t.expect(vars.map((v) => v.name.value)).toEqual(["a", "b", "c"]);
  t.expect(vars.map((v) => (v.initializer as Call).fnName.value)).toEqual([
    "0",
    "1",
    "2",
  ]);
});
