import { describe, expect, test, vi } from "vitest";
import {
  Call,
  Fn,
  Identifier,
  Int,
  List,
  Parameter,
  MockIdentifier,
  Obj,
} from "../../../syntax-objects/index.js";
import {
  TypeAlias,
  UnionType,
  IntersectionType,
  FnType,
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
    alias.resolvedType = i32;

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
    const aObj = new Obj({ name: "A", fields: [] });
    const bObj = new Obj({ name: "B", fields: [] });
    const union = new UnionType({ name: "AB", childTypeExprs: [] });
    union.resolvedMemberTypes = [aObj, bObj];
    const alias = new TypeAlias({
      name: Identifier.from("ABAlias"),
      typeExpr: Identifier.from("AB"),
    });
    alias.resolvedType = union;

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
    const nominal = new Obj({ name: "Nom", fields: [] });
    const structural = new Obj({
      name: "Struct",
      fields: [{ name: "x", typeExpr: Identifier.from("i32"), type: i32 }],
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
    alias.resolvedType = inter;

    const child = new Obj({
      name: "Child",
      fields: [{ name: "x", typeExpr: Identifier.from("i32"), type: i32 }],
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

  test("canonicalType is non-mutating for unions", () => {
    const aObj = new Obj({ name: "A", fields: [] });
    const bObj = new Obj({ name: "B", fields: [] });
    const cObj = new Obj({ name: "C", fields: [] });

    const nested = new UnionType({ name: "Nested", childTypeExprs: [] });
    nested.resolvedMemberTypes = [bObj, cObj];

    const union = new UnionType({ name: "Top", childTypeExprs: [] });
    union.resolvedMemberTypes = [aObj, nested];

    const before = [...union.resolvedMemberTypes];
    const canon1 = canonicalType(union) as UnionType;
    const canon2 = canonicalType(union) as UnionType;

    // Original unchanged
    expect(union.resolvedMemberTypes).toHaveLength(2);
    expect(union.resolvedMemberTypes[0]).toBe(aObj);
    expect(union.resolvedMemberTypes[1]).toBe(nested);
    expect(union.resolvedMemberTypes).toEqual(before);

    // Canonicalized result is flattened and deduped
    expect(canon1).not.toBe(union);
    expect(canon1.resolvedMemberTypes.map((t) => t.id).sort()).toEqual(
      [aObj.id, bObj.id, cObj.id].sort()
    );
    // Idempotent and non-mutating across repeated calls
    expect(canon2.resolvedMemberTypes.map((t) => t.id).sort()).toEqual(
      [aObj.id, bObj.id, cObj.id].sort()
    );
    // Original still unchanged after multiple calls
    expect(union.resolvedMemberTypes).toEqual(before);
  });

  test("canonicalType is non-mutating for function types", () => {
    const aliasRet = new TypeAlias({
      name: Identifier.from("RetAlias"),
      typeExpr: Identifier.from("f32"),
    });
    aliasRet.resolvedType = f32;
    const aliasParam = new TypeAlias({
      name: Identifier.from("ParamAlias"),
      typeExpr: Identifier.from("i32"),
    });
    aliasParam.resolvedType = i32;

    const fnType = new FnType({
      name: Identifier.from("FnT"),
      parameters: [
        new Parameter({ name: Identifier.from("p"), type: aliasParam }),
      ],
      returnType: aliasRet,
    });

    const canon = canonicalType(fnType);

    // Original function type remains unchanged
    expect(fnType.parameters[0]?.type).toBe(aliasParam);
    expect(fnType.returnType).toBe(aliasRet);

    // Canonicalized clone has rewritten types
    expect(canon).not.toBe(fnType);
    if (canon.isFnType?.()) {
      const c = canon;
      expect(c.parameters[0]?.type).toBe(i32);
      expect(c.returnType).toBe(f32);
    }
  });

  test("collapses duplicate union aliases", () => {
    const obj = new Obj({ name: "Obj", fields: [] });
    const alias1 = new TypeAlias({
      name: Identifier.from("Alias1"),
      typeExpr: Identifier.from("Obj"),
    });
    alias1.resolvedType = obj;
    const alias2 = new TypeAlias({
      name: Identifier.from("Alias2"),
      typeExpr: Identifier.from("Obj"),
    });
    alias2.resolvedType = obj;

    const union = new UnionType({ name: "Union", childTypeExprs: [] });
    union.resolvedMemberTypes = [
      alias1.resolvedType as Obj,
      alias2.resolvedType as Obj,
    ];
    const unionAlias = new TypeAlias({
      name: Identifier.from("UnionAlias"),
      typeExpr: Identifier.from("Union"),
    });
    unionAlias.resolvedType = union;

    const fnName = Identifier.from("dup");
    const fn = new Fn({
      name: fnName,
      parameters: [
        new Parameter({ name: Identifier.from("p"), type: unionAlias }),
      ],
    });

    const arg = new MockIdentifier({ value: "o", entity: obj });
    const call = new Call({
      fnName,
      args: new List({ value: [arg] }),
    });
    call.resolveFns = vi.fn().mockReturnValue([fn]);

    resolveCall(call);
    expect(call.fn).toBe(fn);

    const canon = canonicalType(
      unionAlias.resolvedType as UnionType
    ) as UnionType;
    expect(canon.resolvedMemberTypes).toHaveLength(1);
    expect(canon.resolvedMemberTypes[0]).toBe(obj);
  });

  test("matches generic object with alias type arg", () => {
    const base = new Obj({
      name: "Box",
      fields: [],
      typeParameters: [Identifier.from("T")],
    });
    const boxI32 = base.clone();
    boxI32.genericParent = base;
    boxI32.resolvedTypeArgs = [i32];

    const alias = new TypeAlias({
      name: Identifier.from("Alias"),
      typeExpr: Identifier.from("i32"),
    });
    alias.resolvedType = i32;
    const boxAlias = base.clone();
    boxAlias.genericParent = base;
    boxAlias.resolvedTypeArgs = [alias];

    const fnName = Identifier.from("useBox");
    const fn = new Fn({
      name: fnName,
      parameters: [new Parameter({ name: Identifier.from("p"), type: boxI32 })],
    });
    const arg = new MockIdentifier({ value: "b", entity: boxAlias });
    const call = new Call({
      fnName,
      args: new List({ value: [arg] }),
    });
    call.resolveFns = vi.fn().mockReturnValue([fn]);

    resolveCall(call);
    expect(call.fn).toBe(fn);
  });
});
