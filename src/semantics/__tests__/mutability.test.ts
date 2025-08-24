import { test } from "vitest";
import {
  Fn,
  Parameter,
  Call,
  Identifier,
  List,
  Block,
} from "../../syntax-objects/index.js";
import { ObjectType } from "../../syntax-objects/types.js";
import { i32, dVoid } from "../../syntax-objects/types.js";
import { VoydModule } from "../../syntax-objects/module.js";
import { resolveModule } from "../resolution/resolve-entities.js";
import { checkTypes } from "../check-types/index.js";

test("assignment to immutable field throws", (t) => {
  const vec = new ObjectType({
    name: Identifier.from("VecTest"),
    value: [{ name: "x", typeExpr: i32 }],
  });

  const param = new Parameter({ name: Identifier.from("v"), type: vec });
  const access = new Call({
    fnName: Identifier.from("member-access"),
    args: new List({ value: [Identifier.from("v"), Identifier.from("x")] }),
    type: i32,
  });
  const assign = new Call({
    fnName: Identifier.from("="),
    args: new List({ value: [access, 1] }),
  });
  const fn = new Fn({
    name: Identifier.from("bump_bad"),
    parameters: [param],
    returnTypeExpr: dVoid,
    body: new Block({ body: [assign] }),
  });

  const mod = new VoydModule({ name: "test" });
  mod.registerEntity(vec);
  mod.registerEntity(fn);

  resolveModule(mod);

  t.expect(() => checkTypes(fn)).toThrow(/not mutable/);
});
