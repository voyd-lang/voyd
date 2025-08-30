import { describe, test, expect } from "vitest";
import { canonicalTypeExprFromType } from "../canonical-type-expr.js";
import {
  FixedArrayType,
  Identifier,
  ObjectType,
  TypeAlias,
  f32,
  i32,
} from "../../../syntax-objects/index.js";

describe("canonicalTypeExprFromType", () => {
  test("returns primitive directly for i32", () => {
    const expr = canonicalTypeExprFromType(i32);
    expect(expr?.isPrimitiveType()).toBe(true);
    expect((expr as any).name.value).toBe("i32");
  });

  test("returns alias clone for TypeAlias", () => {
    const T = new TypeAlias({ name: Identifier.from("T"), typeExpr: Identifier.from("T") });
    T.type = i32;
    const expr = canonicalTypeExprFromType(T);
    expect(expr?.isTypeAlias()).toBe(true);
    expect((expr as TypeAlias).name.value).toBe("T");
  });

  test("returns nominal object type as-is", () => {
    const Nom = new ObjectType({ name: Identifier.from("Nom"), value: [] });
    const expr = canonicalTypeExprFromType(Nom);
    expect(expr?.isObjectType()).toBe(true);
    expect((expr as ObjectType).name.value).toBe("Nom");
    expect((expr as ObjectType).isStructural).toBe(false);
  });

  test("returns shallow structural form for structural object", () => {
    const structural = new ObjectType({
      name: Identifier.from("Tuple"),
      value: [
        { name: "0", typeExpr: i32, type: i32 },
        { name: "1", typeExpr: f32, type: f32 },
      ],
      isStructural: true,
    });
    const expr = canonicalTypeExprFromType(structural);
    expect(expr?.isObjectType()).toBe(true);
    const obj = expr as ObjectType;
    expect(obj.isStructural).toBe(true);
    expect(obj.getField("0")?.typeExpr.isPrimitiveType()).toBe(true);
    expect(obj.getField("1")?.typeExpr.isPrimitiveType()).toBe(true);
  });

  test("returns FixedArray<primitive> as a type with canonical elem expr", () => {
    const arr = new FixedArrayType({ name: Identifier.from("FixedArray"), elemTypeExpr: i32 });
    arr.elemType = i32;
    const expr = canonicalTypeExprFromType(arr);
    expect(expr?.isFixedArrayType()).toBe(true);
    const fa = expr as FixedArrayType;
    expect(fa.elemTypeExpr.isPrimitiveType()).toBe(true);
  });
});
