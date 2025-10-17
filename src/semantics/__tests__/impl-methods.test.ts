import { test } from "vitest";
import { ObjectType, i32 } from "../../syntax-objects/types.js";
import { Identifier } from "../../syntax-objects/identifier.js";
import { Implementation } from "../../syntax-objects/implementation.js";
import { Fn } from "../../syntax-objects/fn.js";
import { Parameter } from "../../syntax-objects/parameter.js";
import { Block } from "../../syntax-objects/block.js";
import { Call } from "../../syntax-objects/call.js";
import { List } from "../../syntax-objects/list.js";
import { Int } from "../../syntax-objects/int.js";
import { checkTypes } from "../check-types/index.js";

// Regression test for ensuring unresolved calls within methods are detected
// during type checking.
test("unresolved fn calls inside methods throw", (t) => {
  const obj = new ObjectType({
    name: Identifier.from("Test"),
    fields: [{ name: "a", typeExpr: i32, type: i32 }],
    implementations: [],
  });

  const impl = new Implementation({
    parent: obj,
    typeParams: [],
    targetTypeExpr: Identifier.from("Test"),
    body: new Block({ body: [] }),
  });

  const call = new Call({
    fnName: Identifier.from("boop"),
    args: new List({ value: [new Int({ value: 1 })] }),
  });

  const method = new Fn({
    name: Identifier.from("foo"),
    parameters: [new Parameter({ name: Identifier.from("self"), type: obj })],
    body: new Block({ body: [call] }),
    parent: impl,
  });
  method.returnType = i32;

  impl.registerMethod(method);
  obj.implementations.push(impl);

  t.expect(() => checkTypes(obj)).toThrow(/Could not resolve fn boop/);
});
