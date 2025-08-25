import { test, vi } from "vitest";
import { List } from "../../syntax-objects/list.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { Fn } from "../../syntax-objects/fn.js";
import { Parameter } from "../../syntax-objects/parameter.js";
import { Block } from "../../syntax-objects/block.js";
import { Call } from "../../syntax-objects/call.js";
import { initEntities } from "../init-entities.js";
import { checkTypes } from "../check-types/index.js";
import { dVoid } from "../../syntax-objects/types.js";

test("initEntities marks & parameters as mutable", (t) => {
  const fnAst = new List([
    "define_function",
    Identifier.from("bump"),
    new List([
      "parameters",
      new List([":", new List(["&", Identifier.from("v")]), Identifier.from("Vec")]),
    ]),
    new List(["return_type", Identifier.from("voyd")]),
    new List(["block"]),
  ]);
  const fn = initEntities(fnAst) as Fn;
  t.expect(fn.parameters[0].hasAttribute("mutable")).toBe(true);
});

test("initEntities handles labeled mutable parameters", (t) => {
  const fnAst = new List([
    "define_function",
    Identifier.from("bump"),
    new List([
      "parameters",
      new List([
        "object",
        new List([":", new List(["&", Identifier.from("v")]), Identifier.from("Vec")]),
      ]),
    ]),
    new List(["return_type", Identifier.from("voyd")]),
    new List(["block"]),
  ]);
  const fn = initEntities(fnAst) as Fn;
  const param = fn.parameters[0];
  t.expect(param.label?.value).toBe("v");
  t.expect(param.hasAttribute("mutable")).toBe(true);
});

test("checkTypes warns on member access for non-mutable parameter", (t) => {
  const param = new Parameter({ name: Identifier.from("v") });
  const call = new Call({
    fnName: Identifier.from("member-access"),
    args: new List({ value: [Identifier.from("v"), Identifier.from("x")] }),
  });
  const block = new Block({ body: [call] });
  const fn = new Fn({ name: Identifier.from("f"), parameters: [param], body: block });
  fn.returnType = dVoid;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  checkTypes(call);
  t.expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

test("checkTypes allows member access on mutable parameter", (t) => {
  const param = new Parameter({ name: Identifier.from("v") });
  param.setAttribute("mutable", true);
  const call = new Call({
    fnName: Identifier.from("member-access"),
    args: new List({ value: [Identifier.from("v"), Identifier.from("x")] }),
  });
  const block = new Block({ body: [call] });
  const fn = new Fn({ name: Identifier.from("f"), parameters: [param], body: block });
  fn.returnType = dVoid;
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  checkTypes(call);
  t.expect(warn).not.toHaveBeenCalled();
  warn.mockRestore();
});
