import binaryen from "binaryen";
import {
  initFixedArray,
  defineArrayType,
  defineStructType,
  initStruct,
} from "../../lib/binaryen-gc/index.js";
import {
  FixedArrayType,
  IntersectionType,
  ObjectField,
  Type,
} from "../../syntax-objects/types.js";
import { ExpressionRef } from "../../lib/binaryen-gc/types.js";

export const initTypeCompatibilityHelpers = (mod: binaryen.Module) => {};

const initRttInitializer = (mod: binaryen.Module) => {
  const rtt = initRttTypes(mod);

  const newI32 = () => initStruct(mod, rtt.i32, [mod.i32.const(0)]);
  const newI64 = () => initStruct(mod, rtt.i64, [mod.i32.const(1)]);
  const newF32 = () => initStruct(mod, rtt.f32, [mod.i32.const(2)]);
  const newF64 = () => initStruct(mod, rtt.f64, [mod.i32.const(3)]);
  const newNominalObject = (objectId: number) =>
    initStruct(mod, rtt.nominalObject, [
      mod.i32.const(4),
      mod.i32.const(objectId),
    ]);
  const newFields = (fields: ObjectField[]): ExpressionRef => {
    return initFixedArray(
      mod,
      rtt.fields,
      fields.map((field) => newType(field.type!))
    );
  };
  const newStructuralObject = (fields: ObjectField[]): ExpressionRef =>
    initStruct(mod, rtt.structuralObject, [
      mod.i32.const(5),
      mod.i32.const(fields.length),
      newFields(fields),
    ]);
  const newFixedArray = (type: FixedArrayType): ExpressionRef => {
    return initStruct(mod, rtt.fixedArray, [
      mod.i32.const(6),
      newType(type.elemType!),
    ]);
  };
  const newUnion = (nominalIds: number[]): ExpressionRef => {
    return initStruct(mod, rtt.union, [
      mod.i32.const(7),
      initFixedArray(mod, rtt.unionTypes, nominalIds.map(mod.i32.const)),
    ]);
  };
  const newIntersection = (type: IntersectionType): ExpressionRef => {
    return initStruct(mod, rtt.intersection, [
      mod.i32.const(8),
      mod.i32.const(type.idNum),
      newFields(type.structuralType!.fields),
    ]);
  };

  const newType = (type: Type): ExpressionRef => {
    switch (type.kindOfType) {
      case "primitive":
        switch (type.name.value) {
          case "i32":
            return newI32();
          case "i64":
            return newI64();
          case "f32":
            return newF32();
          case "f64":
            return newF64();
          default:
            throw new Error(`Unknown primitive type: ${type.name.value}`);
        }
      case "object":
        if (type.getAttribute("isStructural")) {
          return newStructuralObject(type.fields);
        }

        return newNominalObject(type.idNum);
      case "fixed-array":
        return newFixedArray(type);
      case "union":
        return newUnion(type.types.map((t) => t.idNum));
      case "intersection":
        return newIntersection(type);
      default:
        throw new Error(`Unknown type kind: ${type.kindOfType}`);
    }
  };

  return newType;
};

const initRttTypes = (mod: binaryen.Module) => {
  const base = defineStructType(mod, {
    name: "__RttBase",
    fields: [{ name: "__type_tag", type: binaryen.i32, mutable: false }],
  });

  const i32 = defineStructType(mod, {
    name: "__RttI32",
    supertype: base,
    // __type_tag always 0
    fields: [{ name: "__type_tag", type: binaryen.i32, mutable: false }],
  });

  const i64 = defineStructType(mod, {
    name: "__RttI64",
    supertype: base,
    // __type_tag always 1
    fields: [{ name: "__type_tag", type: binaryen.i32, mutable: false }],
  });

  const f32 = defineStructType(mod, {
    name: "__RttF32",
    supertype: base,
    // __type_tag always 2
    fields: [{ name: "__type_tag", type: binaryen.i32, mutable: false }],
  });

  const f64 = defineStructType(mod, {
    name: "__RttF64",
    supertype: base,
    // __type_tag always 3
    fields: [{ name: "__type_tag", type: binaryen.i32, mutable: false }],
  });

  const nominalObject = defineStructType(mod, {
    name: "__RttNominalObject",
    supertype: base,
    // __type_tag always 4
    fields: [
      { name: "__type_tag", type: binaryen.i32, mutable: false },
      { name: "__object_id", type: binaryen.i32, mutable: false },
    ],
  });

  const field = defineStructType(mod, {
    name: "__RttField",
    fields: [
      { name: "__field_name_hash", type: binaryen.i32, mutable: false },
      { name: "__field_type", type: base, mutable: false },
    ],
  });

  const fields = defineArrayType(mod, field, false, "__RttFields");

  const structuralObject = defineStructType(mod, {
    name: "__RttStructuralObject",
    supertype: base,
    // __type_tag always 5
    fields: [
      { name: "__type_tag", type: binaryen.i32, mutable: false },
      { name: "__fields", type: fields, mutable: false },
    ],
  });

  const fixedArray = defineStructType(mod, {
    name: "__RttFixedArray",
    supertype: base,
    // __type_tag always 6
    fields: [
      { name: "__type_tag", type: binaryen.i32, mutable: false },
      { name: "__array_element_type", type: base, mutable: false },
    ],
  });

  // An array of nominal object ids (since unions can only be made up of nominal objects)
  const unionTypes = defineArrayType(
    mod,
    binaryen.i32,
    false,
    "__RttUnionTypes"
  );

  const union = defineStructType(mod, {
    name: "__RttUnion",
    supertype: base,
    // __type_tag always 7
    fields: [
      { name: "__type_tag", type: binaryen.i32, mutable: false },
      { name: "__union_types", type: unionTypes, mutable: false },
    ],
  });

  const intersection = defineStructType(mod, {
    name: "__RttSIntersection",
    supertype: base,
    // __type_tag always 8
    fields: [
      { name: "__type_tag", type: binaryen.i32, mutable: false },
      { name: "__nominal_object_id", type: binaryen.i32, mutable: false },
      { name: "__fields", type: fields, mutable: false },
    ],
  });

  return {
    base,
    i32,
    i64,
    f32,
    f64,
    nominalObject,
    structuralObject,
    field,
    fields,
    fixedArray,
    union,
    unionTypes,
    intersection,
  };
};
