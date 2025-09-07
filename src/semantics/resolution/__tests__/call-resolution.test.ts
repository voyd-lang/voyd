import { describe, expect, test, vi } from "vitest";
import {
  Call,
  Fn,
  Identifier,
  Int,
  List,
  Parameter,
  MockIdentifier,
} from "../../../syntax-objects/index.js";
import {
  TypeAlias,
  UnionType,
  IntersectionType,
  ObjectType,
  i32,
  f32,
} from "../../../syntax-objects/types.js";
import { resolveCall } from "../resolve-call.js";
import { canonicalType } from "../../types/canonicalize.js";

describe("call resolution canonicalization", () => {
  test("resolves calls with alias parameters", () => {
    const alias = new TypeAlias({
      name: Identifier.from("Alias"),
      typeExpr: Identifier.from("i32"),
    });
    alias.type = i32;

    const fnName = Identifier.from("foo");
    const fn = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: Identifier.from("p"), type: alias })],
    });

    const call = new Call({
      fnName,
      args: new List({ value: [new Int({ value: 1 })] }),
    });
    call.resolveFns = vi.fn().mockReturnValue([fn]);

    resolveCall(call);
    expect(call.fn).toBe(fn);
  });

  test("handles union aliases", () => {
    const aObj = new ObjectType({ name: "A", value: [] });
    const bObj = new ObjectType({ name: "B", value: [] });
    const union = new UnionType({ name: "AB", childTypeExprs: [] });
    union.types = [aObj, bObj];
    const alias = new TypeAlias({
      name: Identifier.from("ABAlias"),
      typeExpr: Identifier.from("AB"),
    });
    alias.type = union;

    const fnName = Identifier.from("bar");
    const fn = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: Identifier.from("p"), type: alias })],
    });

    const arg = new MockIdentifier({ value: "a", entity: aObj });
    const call = new Call({
      fnName,
      args: new List({ value: [arg] }),
    });
    call.resolveFns = vi.fn().mockReturnValue([fn]);

    resolveCall(call);
    expect(call.fn).toBe(fn);
  });

  test("handles intersection aliases", () => {
    const nominal = new ObjectType({ name: "Nom", value: [] });
    const structural = new ObjectType({
      name: "Struct",
      value: [
        { name: "x", typeExpr: Identifier.from("i32"), type: i32 },
      ],
      isStructural: true,
    });
    const inter = new IntersectionType({
      name: "Both",
      nominalObjectExpr: Identifier.from("Nom"),
      structuralObjectExpr: Identifier.from("Struct"),
    });
    inter.nominalType = nominal;
    inter.structuralType = structural;

    const alias = new TypeAlias({
      name: Identifier.from("AliasBoth"),
      typeExpr: Identifier.from("Both"),
    });
    alias.type = inter;

    const child = new ObjectType({
      name: "Child",
      value: [
        { name: "x", typeExpr: Identifier.from("i32"), type: i32 },
      ],
      parentObj: nominal,
    });
    const arg = new MockIdentifier({ value: "c", entity: child });

    const fnName = Identifier.from("baz");
    const fn = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: Identifier.from("p"), type: alias })],
    });

    const call = new Call({
      fnName,
      args: new List({ value: [arg] }),
    });
    call.resolveFns = vi.fn().mockReturnValue([fn]);

    resolveCall(call);
    expect(call.fn).toBe(fn);
  });

  test("collapses duplicate union aliases", () => {
    const obj = new ObjectType({ name: "Obj", value: [] });
    const alias1 = new TypeAlias({
      name: Identifier.from("Alias1"),
      typeExpr: Identifier.from("Obj"),
    });
    alias1.type = obj;
    const alias2 = new TypeAlias({
      name: Identifier.from("Alias2"),
      typeExpr: Identifier.from("Obj"),
    });
    alias2.type = obj;

    const union = new UnionType({ name: "Union", childTypeExprs: [] });
    union.types = [alias1.type as ObjectType, alias2.type as ObjectType];
    const unionAlias = new TypeAlias({
      name: Identifier.from("UnionAlias"),
      typeExpr: Identifier.from("Union"),
    });
    unionAlias.type = union;

    const fnName = Identifier.from("dup");
    const fn = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: Identifier.from("p"), type: unionAlias })],
    });

    const arg = new MockIdentifier({ value: "o", entity: obj });
    const call = new Call({
      fnName,
      args: new List({ value: [arg] }),
    });
    call.resolveFns = vi.fn().mockReturnValue([fn]);

    resolveCall(call);
    expect(call.fn).toBe(fn);

    const canon = canonicalType(unionAlias.type as UnionType) as UnionType;
    expect(canon.types).toHaveLength(1);
    expect(canon.types[0]).toBe(obj);
  });
});
