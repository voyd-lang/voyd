import { parse } from "../../parser/parser.js";
import { Block } from "../../syntax-objects/block.js";
import { Call } from "../../syntax-objects/call.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { Closure } from "../../syntax-objects/closure.js";
import { Fn } from "../../syntax-objects/fn.js";
import { Parameter } from "../../syntax-objects/parameter.js";
import { Variable } from "../../syntax-objects/variable.js";
import { Int } from "../../syntax-objects/int.js";
import { List } from "../../syntax-objects/list.js";
import { initEntities } from "../init-entities.js";
import { resolveEntities } from "../resolution/resolve-entities.js";
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

test("closure captures variable from outer scope", (t) => {
  const variable = new Variable({
    name: Identifier.from("x"),
    initializer: new Int({ value: 1 }),
    isMutable: false,
  });
  const closure = new Closure({
    body: new Block({ body: [Identifier.from("x")] }),
  });
  const block = new Block({ body: [variable, closure] });

  resolveEntities(variable);
  resolveEntities(closure);

  t.expect(closure.captures.length).toBe(1);
  t.expect(closure.captures[0]).toBe(variable);
});

test("closure captures parameter from enclosing function", (t) => {
  const param = new Parameter({ name: Identifier.from("x") });
  const closure = new Closure({
    body: new Block({ body: [Identifier.from("x")] }),
  });
  const fn = new Fn({
    name: Identifier.from("outer"),
    parameters: [param],
    body: new Block({ body: [closure] }),
  });

  resolveEntities(closure);

  t.expect(closure.captures.length).toBe(1);
  t.expect(closure.captures[0]).toBe(param);
});

test("closure captures parameter used as callee", (t) => {
  const param = new Parameter({ name: Identifier.from("cb") });
  const call = new Call({ fnName: Identifier.from("cb"), args: new List({ value: [] }) });
  const closure = new Closure({ body: new Block({ body: [call] }) });
  const fn = new Fn({
    name: Identifier.from("outer"),
    parameters: [param],
    body: new Block({ body: [closure] }),
  });

  resolveEntities(closure);

  t.expect(closure.captures.length).toBe(1);
  t.expect(closure.captures[0]).toBe(param);
});

