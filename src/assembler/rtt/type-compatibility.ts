import binaryen from "binaryen";
import {
  initFixedArray,
  defineArrayType,
  defineStructType,
  initStruct,
  structGetFieldValue,
  refCast,
  arrayLen,
} from "../../lib/binaryen-gc/index.js";
import {
  FixedArrayType,
  IntersectionType,
  ObjectField,
  ObjectType,
  Type,
} from "../../syntax-objects/types.js";
import {
  AugmentedBinaryen,
  ExpressionRef,
} from "../../lib/binaryen-gc/types.js";

const bin = binaryen as unknown as AugmentedBinaryen;

/**
 * Used entirely for finding the right trait implementation for first
 * class trait type support
 */
export const initTypeCompatibilityHelpers = (mod: binaryen.Module) => {
  const rtt = initRttTypes(mod);
  const newType = initTypeMaker(mod, rtt);
  const newVoyd = (): ExpressionRef => {
    return initStruct(mod, rtt.voyd, [mod.i32.const(10)]);
  };

  const getUnionTypes = (localIndex: number) =>
    structGetFieldValue({
      mod,
      fieldType: rtt.union,
      fieldIndex: 1,
      exprRef: mod.local.get(localIndex, rtt.union),
    });

  // Where localIndex is the index of the local variable that holds the rtt (a struct that extends __RttBase)
  const getRttTypeId = (localIndex: number) =>
    structGetFieldValue({
      mod,
      fieldType: rtt.base,
      fieldIndex: 0,
      exprRef: mod.local.get(localIndex, rtt.base),
    });

  const getNominalId = (localIndex: number) =>
    structGetFieldValue({
      mod,
      fieldType: rtt.nominalObject,
      fieldIndex: 1,
      exprRef: refCast(
        mod,
        mod.local.get(localIndex, rtt.base),
        rtt.nominalObject
      ),
    });

  mod.addFunction(
    "__are_types_compatible",
    // Type A, Type B -- Checking if type a is compatible with type b
    binaryen.createType([rtt.base, rtt.base]),
    binaryen.i32, // bool
    [],
    mod.block(null, [
      // At this point, if the types aren't the same kind of RTT, they're not compatible, return false
      mod.if(
        mod.i32.ne(getRttTypeId(0), getRttTypeId(1)),
        mod.return(mod.i32.const(0))
      ),

      // If a and b are a nominal type, check that they're the same nominal type
      mod.if(
        mod.i32.and(
          mod.i32.eq(getRttTypeId(0), mod.i32.const(4)),
          mod.i32.eq(getRttTypeId(1), mod.i32.const(4))
        ),
        mod.i32.eq(getNominalId(0), getNominalId(1))
      ),

      // If we get here the types are compatible primitive types
      mod.i32.const(1),
    ])
  );
};

const initTypeMaker = (mod: binaryen.Module, rtt: RttTypes) => {
  const newI32 = () =>
    initStruct(mod, rtt.primitive, [mod.i32.const(0), mod.i32.const(0)]);
  const newI64 = () =>
    initStruct(mod, rtt.primitive, [mod.i32.const(0), mod.i32.const(1)]);
  const newF32 = () =>
    initStruct(mod, rtt.primitive, [mod.i32.const(0), mod.i32.const(2)]);
  const newF64 = () =>
    initStruct(mod, rtt.primitive, [mod.i32.const(0), mod.i32.const(3)]);
  const newString = () =>
    initStruct(mod, rtt.primitive, [mod.i32.const(0), mod.i32.const(4)]);
  const newBool = () =>
    initStruct(mod, rtt.primitive, [mod.i32.const(0), mod.i32.const(5)]);

  const newNominalObject = (object: ObjectType) =>
    initStruct(mod, rtt.nominalObject, [
      mod.i32.const(4),
      mod.i32.const(object.idNum),
      newFields(object.fields),
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
          case "string":
            return newString();
          case "bool":
            return newBool();
          default:
            throw new Error(`Unknown primitive type: ${type.name.value}`);
        }
      case "object":
        if (type.getAttribute("isStructural")) {
          return newStructuralObject(type.fields);
        }

        return newNominalObject(type);
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

  // A primitive type that cannot have variations
  const primitive = defineStructType(mod, {
    name: "__RttPrimitive",
    supertype: base,
    // __type_tag always 0
    fields: [
      { name: "__type_tag", type: binaryen.i32, mutable: false },
      { name: "__primitive_type_id", type: binaryen.i32, mutable: false },
    ],
  });

  const field = defineStructType(mod, {
    name: "__RttField",
    fields: [
      { name: "__field_name_hash", type: binaryen.i32, mutable: false },
      { name: "__field_type", type: base, mutable: false },
      { name: "__field_getter", type: bin.funcref, mutable: false },
      { name: "__field_setter", type: bin.funcref, mutable: false },
    ],
  });

  const fields = defineArrayType(mod, field, false, "__RttFields");
  const ancestors = defineArrayType(mod, binaryen.i32, false, "__RttAncestors");

  const nominalObject = defineStructType(mod, {
    name: "__RttNominalObject",
    supertype: base,
    fields: [
      { name: "__type_tag", type: binaryen.i32, mutable: false }, // __type_tag always 4
      { name: "__ancestors", type: ancestors, mutable: false },
      { name: "__fields", type: fields, mutable: false },
    ],
  });

  const structuralObject = defineStructType(mod, {
    name: "__RttStructuralObject",
    supertype: base,
    fields: [
      { name: "__type_tag", type: binaryen.i32, mutable: false }, // __type_tag always 5
      { name: "__ancestors", type: ancestors, mutable: false },
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

  // Used when a field is not found
  const voyd = defineStructType(mod, {
    name: "__RttNotFound",
    supertype: base,
    fields: [
      // __type_tag always 10
      { name: "__type_tag", type: binaryen.i32, mutable: false },
    ],
  });

  return {
    base,
    primitive,
    nominalObject,
    structuralObject,
    field,
    fields,
    fixedArray,
    union,
    unionTypes,
    intersection,
    voyd,
  };
};

type RttTypes = ReturnType<typeof initRttTypes>;
