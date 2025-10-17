import { describe, expect, test } from "vitest";
import {
  ObjectType,
  UnionType,
  Identifier,
  TypeAlias,
} from "../../../syntax-objects/index.js";
import { typesAreEqual } from "../types-are-equal.js";

describe("typesAreEqual", () => {
  test("treats different generic args as distinct", () => {
    const string = new ObjectType({ name: "String", fields: [] });
    const jsonObj = new ObjectType({ name: "JsonObj", fields: [] });

    const json = new UnionType({ name: "Json", childTypeExprs: [] });
    json.resolvedMemberTypes = [jsonObj, string];

    const MsgPack = new UnionType({ name: "MsgPack", childTypeExprs: [] });
    MsgPack.resolvedMemberTypes = [string];

    const array = new ObjectType({
      name: "Array",
      fields: [],
      typeParameters: [new Identifier({ value: "T" })],
    });

    const arrJson = array.clone();
    arrJson.genericParent = array;
    const argJson = new TypeAlias({
      name: new Identifier({ value: "T" }),
      typeExpr: new Identifier({ value: "Json" }),
    });
    argJson.resolvedType = json;
    arrJson.resolvedTypeArgs = [argJson];

    const arrMini = array.clone();
    arrMini.genericParent = array;
    const argMini = new TypeAlias({
      name: new Identifier({ value: "T" }),
      typeExpr: new Identifier({ value: "MsgPack" }),
    });
    argMini.resolvedType = MsgPack;
    arrMini.resolvedTypeArgs = [argMini];

    expect(typesAreEqual(arrJson, arrMini)).toBe(false);
  });
});
