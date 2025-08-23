import { describe, expect, test } from "vitest";
import {
  Call,
  Identifier,
  List,
  MockIdentifier,
  ObjectType,
  TypeAlias,
  UnionType,
  i32,
  voydString,
} from "../../../syntax-objects/index.js";
import { resolveTypeExpr } from "../resolve-type-expr.js";
import { getExprType } from "../get-expr-type.js";

describe("resolveObjectType - generic instance reuse", () => {
  test("ignores existing instances with out-of-scope types", () => {
    const arrayType = new ObjectType({
      name: new Identifier({ value: "Array" }),
      value: [],
      typeParameters: [new Identifier({ value: "T" })],
    });

    // First type alias Json = string | i32
    const jsonUnion = new UnionType({
      name: new Identifier({ value: "JsonUnion" }),
      childTypeExprs: [voydString, i32],
    });
    jsonUnion.types = [voydString, i32];
    const jsonAlias = new TypeAlias({
      name: new Identifier({ value: "Json" }),
      typeExpr: jsonUnion,
    });
    jsonAlias.type = jsonUnion;

    // Second type alias MiniJson = string | i32
    const miniUnion = new UnionType({
      name: new Identifier({ value: "MiniJsonUnion" }),
      childTypeExprs: [voydString, i32],
    });
    miniUnion.types = [voydString, i32];
    const miniAlias = new TypeAlias({
      name: new Identifier({ value: "MiniJson" }),
      typeExpr: miniUnion,
    });
    miniAlias.type = miniUnion;

    // Resolve Array<Json> to populate generic instances
    const jsonCall = new Call({
      fnName: new MockIdentifier({ value: "Array", entity: arrayType }),
      args: new List({}),
      typeArgs: new List({}),
    });
    jsonCall.typeArgs!.push(
      new MockIdentifier({ value: "Json", entity: jsonAlias })
    );
    resolveTypeExpr(jsonCall);

    // Resolve Array<MiniJson>
    const miniCall = new Call({
      fnName: new MockIdentifier({ value: "Array", entity: arrayType }),
      args: new List({}),
      typeArgs: new List({}),
    });
    miniCall.typeArgs!.push(
      new MockIdentifier({ value: "MiniJson", entity: miniAlias })
    );
    resolveTypeExpr(miniCall);
    const resolved = miniCall.type?.isObjectType() ? miniCall.type : undefined;
    const argType = getExprType(resolved?.appliedTypeArgs?.[0]);

    expect(argType).toBe(miniUnion);
  });
});
