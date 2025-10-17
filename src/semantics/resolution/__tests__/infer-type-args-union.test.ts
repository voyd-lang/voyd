import { describe, test, expect } from "vitest";
import { inferTypeArgs } from "../infer-type-args.js";
import { Identifier, Call, List, Obj } from "../../../syntax-objects/index.js";
import { TypeAlias, UnionType, f32 } from "../../../syntax-objects/types.js";
import { resolveUnionType } from "../resolve-union.js";

const typeCall = (name: string, typeArgs: any[] = []) =>
  new Call({
    fnName: Identifier.from(name),
    args: new List({ value: [] }),
    typeArgs: new List({ value: typeArgs }),
  });

describe("inferTypeArgs union", () => {
  test("infers T from (Array<T> | String) given (Array<f32> | String)", () => {
    const arrayGeneric = new Obj({
      name: Identifier.from("Array"),
      fields: [],
      typeParameters: [Identifier.from("T")],
    });
    const stringType = new Obj({
      name: Identifier.from("String"),
      fields: [],
    });

    const arrayF32 = arrayGeneric.clone();
    const applied = new TypeAlias({
      name: Identifier.from("T"),
      typeExpr: Identifier.from("T"),
    });
    applied.resolvedType = f32;
    arrayF32.genericParent = arrayGeneric;
    arrayF32.resolvedTypeArgs = [applied];

    const paramUnion = new UnionType({
      name: Identifier.from("Union"),
      childTypeExprs: [typeCall("Array", [Identifier.from("T")]), stringType],
    });
    const argUnion = new UnionType({
      name: Identifier.from("Union"),
      childTypeExprs: [arrayF32, stringType],
    });
    resolveUnionType(argUnion);

    const typeParams = [Identifier.from("T")];
    const pairs = [{ typeExpr: paramUnion, argExpr: argUnion }];
    const inferred = inferTypeArgs(typeParams, pairs);
    expect(inferred).toBeDefined();
    const alias = inferred!.exprAt(0) as TypeAlias;
    expect(alias.name.value).toBe("T");
    expect(alias.resolvedType?.id).toBe(f32.id);
  });
});
