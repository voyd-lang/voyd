import { describe, expect, test } from "vitest";
import {
  ObjectType,
  UnionType,
  Identifier,
  TypeAlias,
  voydString,
} from "../../../syntax-objects/index.js";
import { typesAreEqual } from "../types-are-equal.js";

describe("typesAreEqual", () => {
  test("treats different generic args as distinct", () => {
    const string = voydString;
    const jsonObj = new ObjectType({ name: "JsonObj", value: [] });

    const json = new UnionType({ name: "Json", childTypeExprs: [] });
    json.types = [jsonObj, string];

    const miniJson = new UnionType({ name: "MiniJson", childTypeExprs: [] });
    miniJson.types = [string];

    const array = new ObjectType({
      name: "Array",
      value: [],
      typeParameters: [new Identifier({ value: "T" })],
    });

    const arrJson = array.clone();
    arrJson.genericParent = array;
    const argJson = new TypeAlias({
      name: new Identifier({ value: "T" }),
      typeExpr: new Identifier({ value: "Json" }),
    });
    argJson.type = json;
    arrJson.appliedTypeArgs = [argJson];

    const arrMini = array.clone();
    arrMini.genericParent = array;
    const argMini = new TypeAlias({
      name: new Identifier({ value: "T" }),
      typeExpr: new Identifier({ value: "MiniJson" }),
    });
    argMini.type = miniJson;
    arrMini.appliedTypeArgs = [argMini];

    expect(typesAreEqual(arrJson, arrMini)).toBe(false);
  });
});
