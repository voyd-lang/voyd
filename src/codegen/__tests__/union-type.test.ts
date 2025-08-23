import { describe, expect, test } from "vitest";
import binaryen from "binaryen";
import { buildUnionType } from "../../codegen.js";
import { UnionType, ObjectType, PrimitiveType } from "../../syntax-objects/index.js";

const makeOpts = () => ({
  expr: new ObjectType({ name: "dummy", value: [] }),
  mod: new binaryen.Module(),
  extensionHelpers: {} as any,
  fieldLookupHelpers: { lookupTableType: binaryen.none } as any,
  methodLookupHelpers: { lookupTableType: binaryen.none } as any,
});

describe("buildUnionType", () => {
  test("uses anyref when union has primitives", () => {
    const union = new UnionType({ name: "U", childTypeExprs: [] });
    union.types = [new ObjectType({ name: "Obj", value: [] }), PrimitiveType.from("string")];
    const typeRef = buildUnionType(makeOpts(), union);
    expect(typeRef).toBe(binaryen.anyref);
  });
});
