import { describe, test, expect } from "vitest";
import { inferTypeArgs } from "../infer-type-args.js";
import {
  Call,
  Identifier,
  List,
} from "../../../syntax-objects/index.js";
import { ObjectType, TypeAlias, i32, f32 } from "../../../syntax-objects/types.js";

/**
 * Helper: build a type-call expression like Array<...> for parameter side.
 */
const typeCall = (name: string, typeArgs: any[] = []) =>
  new Call({
    fnName: Identifier.from(name),
    args: new List({ value: [] }),
    typeArgs: new List({ value: typeArgs }),
  });

describe("inferTypeArgs structural unification", () => {
  test("infers T from Array<(String, T)> given Array<(String, i32)>", () => {
    // Generic object type Array<T>
    const arrayGeneric = new ObjectType({
      name: Identifier.from("Array"),
      value: [],
      typeParameters: [Identifier.from("T")],
    });

    // Reuse the same String type instance on both sides for equality
    const stringType = new ObjectType({ name: Identifier.from("String"), value: [] });

    // Parameter side: Array<(String, T)>
    const paramTuple = new ObjectType({
      name: Identifier.from("Tuple"),
      value: [
        { name: "0", typeExpr: stringType },
        { name: "1", typeExpr: Identifier.from("T") },
      ],
      isStructural: true,
    });
    const paramTypeExpr = typeCall("Array", [paramTuple]);

    // Argument side: Array<(String, i32)>
    const argTupleType = new ObjectType({
      name: Identifier.from("Tuple"),
      value: [
        { name: "0", typeExpr: stringType, type: stringType },
        { name: "1", typeExpr: i32, type: i32 },
      ],
      isStructural: true,
    });
    const appliedT = new TypeAlias({ name: Identifier.from("T"), typeExpr: Identifier.from("T") });
    appliedT.type = argTupleType;

    const arrayConcrete = arrayGeneric.clone();
    arrayConcrete.genericParent = arrayGeneric;
    arrayConcrete.appliedTypeArgs = [appliedT];

    const typeParams = [Identifier.from("T")];
    const pairs = [{ typeExpr: paramTypeExpr, argExpr: arrayConcrete }];

    const inferred = inferTypeArgs(typeParams, pairs);
    expect(inferred).toBeDefined();
    const alias = inferred!.exprAt(0) as TypeAlias;
    expect(alias.isTypeAlias()).toBe(true);
    expect(alias.name.value).toBe("T");
    expect(alias.type?.id).toBe(i32.id);
  });

  test("conflicting occurrences of T return undefined", () => {
    const arrayGeneric = new ObjectType({
      name: Identifier.from("Array"),
      value: [],
      typeParameters: [Identifier.from("T")],
    });
    const stringType = new ObjectType({ name: Identifier.from("String"), value: [] });

    const paramTuple = new ObjectType({
      name: Identifier.from("Tuple"),
      value: [
        { name: "0", typeExpr: stringType },
        { name: "1", typeExpr: Identifier.from("T") },
      ],
      isStructural: true,
    });
    const paramTypeExpr = typeCall("Array", [paramTuple]);

    // First arg: Array<(String, i32)>
    const tupleI32 = new ObjectType({
      name: Identifier.from("Tuple"),
      value: [
        { name: "0", typeExpr: stringType, type: stringType },
        { name: "1", typeExpr: i32, type: i32 },
      ],
      isStructural: true,
    });
    const appliedI32 = new TypeAlias({ name: Identifier.from("T"), typeExpr: Identifier.from("T") });
    appliedI32.type = tupleI32;
    const arrayI32 = arrayGeneric.clone();
    arrayI32.genericParent = arrayGeneric;
    arrayI32.appliedTypeArgs = [appliedI32];

    // Second arg: Array<(String, f32)> to conflict with T inferred as i32
    const tupleF32 = new ObjectType({
      name: Identifier.from("Tuple"),
      value: [
        { name: "0", typeExpr: stringType, type: stringType },
        { name: "1", typeExpr: f32, type: f32 },
      ],
      isStructural: true,
    });
    const appliedF32 = new TypeAlias({ name: Identifier.from("T"), typeExpr: Identifier.from("T") });
    appliedF32.type = tupleF32;
    const arrayF32 = arrayGeneric.clone();
    arrayF32.genericParent = arrayGeneric;
    arrayF32.appliedTypeArgs = [appliedF32];

    const typeParams = [Identifier.from("T")];
    const pairs = [
      { typeExpr: paramTypeExpr, argExpr: arrayI32 },
      { typeExpr: paramTypeExpr, argExpr: arrayF32 },
    ];

    const inferred = inferTypeArgs(typeParams, pairs);
    expect(inferred).toBeUndefined();
  });
});
