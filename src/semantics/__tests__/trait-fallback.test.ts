import { test } from "vitest";
import { TraitType } from "../../syntax-objects/trait.js";
import {
  Fn,
  Parameter,
  Call,
  Identifier,
  List,
  Block,
} from "../../syntax-objects/index.js";
import { VoydModule } from "../../syntax-objects/module.js";
import { i32 } from "../../syntax-objects/types.js";
import { resolveEntities } from "../resolution/resolve-entities.js";
import { checkTypes } from "../check-types/index.js";

test("trait method calls resolve via fallback", (t) => {
  const runFn = new Fn({
    name: Identifier.from("run"),
    parameters: [new Parameter({ name: Identifier.from("self") })],
    returnTypeExpr: i32,
    body: new Block({ body: [] }),
  });
  const trait = new TraitType({
    name: Identifier.from("Run"),
    methods: [runFn],
  });

  const param = new Parameter({ name: Identifier.from("r"), type: trait });
  const callExpr = new Call({
    fnName: Identifier.from("run"),
    args: new List({ value: [Identifier.from("r")] }),
  });
  const fn = new Fn({
    name: Identifier.from("call"),
    parameters: [param],
    returnTypeExpr: i32,
    body: new Block({ body: [callExpr] }),
  });

  const module = new VoydModule({ name: "test" });
  module.registerEntity(trait);
  module.registerEntity(fn);

  resolveEntities(fn);

  t.expect(callExpr.fn).toBe(runFn);
  t.expect(callExpr.type).toBe(i32);

  t.expect(() => checkTypes(fn)).not.toThrow();
});
