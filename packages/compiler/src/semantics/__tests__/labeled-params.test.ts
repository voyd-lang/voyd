import { test } from "vitest";
import { initEntities } from "../init-entities.js";
import { List } from "../../syntax-objects/list.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { Fn } from "../../syntax-objects/fn.js";

const param = (name: string, type: string) =>
  new List([":", Identifier.from(name), Identifier.from(type)]);

const fnTemplate = (params: List) =>
  new List([
    "define_function",
    Identifier.from("add"),
    new List(["parameters", ...params.toArray()]),
    new List(["return_type"]),
    new List(["block"]),
  ]);

test("initEntities assigns label for wrapped parameter", (t) => {
  const params = new List([
    param("a", "i32"),
    new List(["object", new List([":", Identifier.from("to"), Identifier.from("i32")])]),
  ]);
  const fn = initEntities(fnTemplate(params)) as Fn;
  t.expect(fn.parameters.map((p) => p.label?.value)).toEqual([undefined, "to"]);
});

test("initEntities supports explicit external labels", (t) => {
  const params = new List([
    param("a", "i32"),
    new List([
      "object",
      new List([
        Identifier.from("to"),
        param("b", "i32"),
      ]),
    ]),
  ]);
  const fn = initEntities(fnTemplate(params)) as Fn;
  t.expect(fn.parameters[1].name.value).toBe("b");
  t.expect(fn.parameters[1].label?.value).toBe("to");
});
