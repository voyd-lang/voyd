import { parse } from "../../parser/parser.js";
import { initEntities } from "../init-entities.js";
import { test } from "vitest";

test("initEntities creates closure syntax object", (t) => {
  const ast = parse("() => 5");
  const closureExpr = ast.exprAt(1);
  const closure = initEntities(closureExpr);
  t.expect(closure.isClosure()).toBe(true);
  if (closure.isClosure()) {
    t.expect(closure.parameters.length).toBe(0);
  }
});

