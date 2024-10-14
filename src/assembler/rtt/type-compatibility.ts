import binaryen from "binaryen";
import {
  initFixedArray,
  defineArrayType,
  defineStructType,
  initStruct,
  structGetFieldValue,
  refCast,
  arrayLen,
  arrayGet,
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
 * Used entirely for finding the right trait implementation for trait objects
 * (first class trait types)
 *
 * NOTE: This is a WIP. To be completed as part of trait object support in
 * post MVP. https://linear.app/voyd-lang/issue/V-131/trait-objects
 */
export const initTypeCompatibilityHelpers = (mod: binaryen.Module) => {
  const rtt = initRttTypes(mod);
  const i32Array = defineArrayType(mod, bin.i32, false, "__I32Array");
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

  // Implementing __are_types_compatible with full logic
  mod.addFunction(
    "__are_types_compatible",
    binaryen.createType([rtt.base, rtt.base]),
    binaryen.i32, // bool (i32 in WebAssembly)
    [
      binaryen.i32, // __type_tag_a
      binaryen.i32, // __type_tag_b
      binaryen.i32, // temp variables
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
      binaryen.i32,
    ],
    mod.block(null, [
      // Local indices:
      // 0: a (rtt.base)
      // 1: b (rtt.base)
      // 2: __type_tag_a (i32)
      // 3: __type_tag_b (i32)
      // 4-12: temp variables

      // if (!a || !b) return false;
      mod.if(
        mod.i32.or(
          mod.ref.is_null(mod.local.get(0, rtt.base)),
          mod.ref.is_null(mod.local.get(1, rtt.base))
        ),
        mod.return(mod.i32.const(0))
      ),

      // __type_tag_a = getRttTypeId(a)
      mod.local.set(2, getRttTypeId(0)),

      // __type_tag_b = getRttTypeId(b)
      mod.local.set(3, getRttTypeId(1)),

      // if (a.isPrimitiveType() && b.isPrimitiveType())
      mod.if(
        mod.i32.and(
          mod.i32.eq(mod.local.get(2, binaryen.i32), mod.i32.const(0)), // __type_tag == 0
          mod.i32.eq(mod.local.get(3, binaryen.i32), mod.i32.const(0))
        ),
        mod.block(null, [
          // Get __primitive_type_id of a
          mod.local.set(
            4,
            structGetFieldValue({
              mod,
              fieldType: rtt.primitive,
              fieldIndex: 1, // __primitive_type_id
              exprRef: refCast(mod, mod.local.get(0, rtt.base), rtt.primitive),
            })
          ),
          // Get __primitive_type_id of b
          mod.local.set(
            5,
            structGetFieldValue({
              mod,
              fieldType: rtt.primitive,
              fieldIndex: 1, // __primitive_type_id
              exprRef: refCast(mod, mod.local.get(1, rtt.base), rtt.primitive),
            })
          ),
          // return a.id === b.id;
          mod.return(
            mod.i32.eq(
              mod.local.get(4, binaryen.i32),
              mod.local.get(5, binaryen.i32)
            )
          ),
        ])
      ),

      // if (a.isObjectType() && b.isObjectType())
      mod.if(
        mod.i32.and(
          mod.i32.or(
            mod.i32.eq(mod.local.get(2, binaryen.i32), mod.i32.const(4)), // __type_tag == 4 (__RttNominalObject)
            mod.i32.eq(mod.local.get(2, binaryen.i32), mod.i32.const(5)) // __type_tag == 5 (__RttStructuralObject)
          ),
          mod.i32.or(
            mod.i32.eq(mod.local.get(3, binaryen.i32), mod.i32.const(4)),
            mod.i32.eq(mod.local.get(3, binaryen.i32), mod.i32.const(5))
          )
        ),
        mod.block(null, [
          // const structural = b.isStructural;
          mod.local.set(
            4,
            mod.i32.eq(mod.local.get(3, binaryen.i32), mod.i32.const(5)) // structural if __type_tag_b == 5
          ),

          // if (structural)
          mod.if(
            mod.local.get(4, binaryen.i32),
            mod.block(null, [
              // Structural comparison
              // Get b's fields
              mod.local.set(
                5,
                structGetFieldValue({
                  mod,
                  fieldType: rtt.structuralObject,
                  fieldIndex: 2, // __fields
                  exprRef: refCast(
                    mod,
                    mod.local.get(1, rtt.base),
                    rtt.structuralObject
                  ),
                })
              ),

              // Get the length of b's fields
              mod.local.set(6, arrayLen(mod, mod.local.get(5, rtt.fields))),

              // Initialize index i = 0
              mod.local.set(7, mod.i32.const(0)),

              mod.loop(
                "field_loop",
                mod.block("end_field_loop", [
                  // if (i >= len_b_fields) break;
                  mod.if(
                    mod.i32.ge_s(
                      mod.local.get(7, binaryen.i32),
                      mod.local.get(6, binaryen.i32)
                    ),
                    mod.br("end_field_loop")
                  ),

                  // Get b_field = b.fields[i]
                  mod.local.set(
                    8,
                    arrayGet(
                      mod,
                      mod.local.get(5, rtt.fields),
                      mod.local.get(7, binaryen.i32),
                      rtt.field,
                      false
                    )
                  ),

                  // Get b_field_name_hash = b_field.__field_name_hash
                  mod.local.set(
                    9,
                    structGetFieldValue({
                      mod,
                      fieldType: rtt.field,
                      fieldIndex: 0, // __field_name_hash
                      exprRef: mod.local.get(8, rtt.field),
                    })
                  ),

                  // Get a's fields
                  mod.local.set(
                    10,
                    structGetFieldValue({
                      mod,
                      fieldType: rtt.structuralObject,
                      fieldIndex: 2, // __fields
                      exprRef: refCast(
                        mod,
                        mod.local.get(0, rtt.base),
                        rtt.structuralObject
                      ),
                    })
                  ),

                  // Get length of a's fields
                  mod.local.set(
                    11,
                    arrayLen(mod, mod.local.get(10, rtt.fields))
                  ),

                  // Initialize j = 0
                  mod.local.set(12, mod.i32.const(0)),

                  // Initialize found = false
                  mod.local.set(13, mod.i32.const(0)),

                  mod.loop(
                    "inner_loop",
                    mod.block("end_inner_loop", [
                      // if (j >= len_a_fields) break;
                      mod.if(
                        mod.i32.ge_s(
                          mod.local.get(12, binaryen.i32),
                          mod.local.get(11, binaryen.i32)
                        ),
                        mod.br("end_inner_loop")
                      ),

                      // Get a_field = a.fields[j]
                      mod.local.set(
                        14,
                        arrayGet(
                          mod,
                          mod.local.get(10, rtt.fields),
                          mod.local.get(12, binaryen.i32),
                          rtt.field,
                          false
                        )
                      ),

                      // Get a_field_name_hash = a_field.__field_name_hash
                      mod.local.set(
                        15,
                        structGetFieldValue({
                          mod,
                          fieldType: rtt.field,
                          fieldIndex: 0, // __field_name_hash
                          exprRef: mod.local.get(14, rtt.field),
                        })
                      ),

                      // if (a_field_name_hash == b_field_name_hash)
                      mod.if(
                        mod.i32.eq(
                          mod.local.get(15, binaryen.i32),
                          mod.local.get(9, binaryen.i32)
                        ),
                        mod.block(null, [
                          // Get a_field_type = a_field.__field_type
                          mod.local.set(
                            16,
                            structGetFieldValue({
                              mod,
                              fieldType: rtt.field,
                              fieldIndex: 1, // __field_type
                              exprRef: mod.local.get(14, rtt.field),
                            })
                          ),

                          // Get b_field_type = b_field.__field_type
                          mod.local.set(
                            17,
                            structGetFieldValue({
                              mod,
                              fieldType: rtt.field,
                              fieldIndex: 1, // __field_type
                              exprRef: mod.local.get(8, rtt.field),
                            })
                          ),

                          // Check typesAreCompatible(a_field_type, b_field_type)
                          mod.local.set(
                            18,
                            mod.call(
                              "__are_types_compatible",
                              [
                                mod.local.get(16, rtt.base),
                                mod.local.get(17, rtt.base),
                              ],
                              binaryen.i32
                            )
                          ),

                          // if (!typesAreCompatible) return false;
                          mod.if(
                            mod.i32.eq(
                              mod.local.get(18, binaryen.i32),
                              mod.i32.const(0)
                            ),
                            mod.return(mod.i32.const(0))
                          ),

                          // Set found = true
                          mod.local.set(13, mod.i32.const(1)),

                          // Break inner loop
                          mod.br("end_inner_loop"),
                        ])
                      ),

                      // Increment j
                      mod.local.set(
                        12,
                        mod.i32.add(
                          mod.local.get(12, binaryen.i32),
                          mod.i32.const(1)
                        )
                      ),

                      // Continue inner loop
                      mod.br("inner_loop"),
                    ])
                  ),

                  // If not found, return false
                  mod.if(
                    mod.i32.eq(
                      mod.local.get(13, binaryen.i32),
                      mod.i32.const(0)
                    ),
                    mod.return(mod.i32.const(0))
                  ),

                  // Increment i
                  mod.local.set(
                    7,
                    mod.i32.add(
                      mod.local.get(7, binaryen.i32),
                      mod.i32.const(1)
                    )
                  ),

                  // Continue outer loop
                  mod.br("field_loop"),
                ])
              ),

              // All fields matched, return true
              mod.return(mod.i32.const(1)),
            ]),
            // else
            mod.block(null, [
              // Nominal comparison
              // Get a's nominal ID
              mod.local.set(5, getNominalId(0)),
              // Get b's nominal ID
              mod.local.set(6, getNominalId(1)),
              // If a's nominal ID is zero, return false
              mod.if(
                mod.i32.eq(mod.local.get(5, binaryen.i32), mod.i32.const(0)),
                mod.return(mod.i32.const(0))
              ),
              // If a.id === b.id return true
              mod.if(
                mod.i32.eq(
                  mod.local.get(5, binaryen.i32),
                  mod.local.get(6, binaryen.i32)
                ),
                mod.return(mod.i32.const(1))
              ),
              // Else, check if a extends b
              mod.return(
                mod.call(
                  "__extends_nominal",
                  [mod.local.get(0, rtt.base), mod.local.get(6, binaryen.i32)],
                  binaryen.i32
                )
              ),
            ])
          ),
        ])
      ),

      // if (a.isObjectType() && b.isUnionType())
      mod.if(
        mod.i32.and(
          mod.i32.or(
            mod.i32.eq(mod.local.get(2, binaryen.i32), mod.i32.const(4)),
            mod.i32.eq(mod.local.get(2, binaryen.i32), mod.i32.const(5))
          ),
          mod.i32.eq(mod.local.get(3, binaryen.i32), mod.i32.const(7)) // __type_tag == 7 (__RttUnion)
        ),
        mod.block(null, [
          // Return __object_type_in_union(a, b)
          mod.return(
            mod.call(
              "__object_type_in_union",
              [mod.local.get(0, rtt.base), mod.local.get(1, rtt.base)],
              binaryen.i32
            )
          ),
        ])
      ),

      // if (a.isUnionType() && b.isUnionType())
      mod.if(
        mod.i32.and(
          mod.i32.eq(mod.local.get(2, binaryen.i32), mod.i32.const(7)), // __type_tag == 7 (__RttUnion)
          mod.i32.eq(mod.local.get(3, binaryen.i32), mod.i32.const(7))
        ),
        mod.block(null, [
          // Return __unions_are_compatible(a, b)
          mod.return(
            mod.call(
              "__unions_are_compatible",
              [mod.local.get(0, rtt.base), mod.local.get(1, rtt.base)],
              binaryen.i32
            )
          ),
        ])
      ),

      // if (a.isFixedArrayType() && b.isFixedArrayType())
      mod.if(
        mod.i32.and(
          mod.i32.eq(mod.local.get(2, binaryen.i32), mod.i32.const(6)), // __type_tag == 6 (__RttFixedArray)
          mod.i32.eq(mod.local.get(3, binaryen.i32), mod.i32.const(6))
        ),
        mod.block(null, [
          // Return typesAreCompatible(a.elemType, b.elemType);
          mod.local.set(
            4,
            structGetFieldValue({
              mod,
              fieldType: rtt.fixedArray,
              fieldIndex: 1, // __array_element_type
              exprRef: refCast(mod, mod.local.get(0, rtt.base), rtt.fixedArray),
            })
          ),
          mod.local.set(
            5,
            structGetFieldValue({
              mod,
              fieldType: rtt.fixedArray,
              fieldIndex: 1, // __array_element_type
              exprRef: refCast(mod, mod.local.get(1, rtt.base), rtt.fixedArray),
            })
          ),
          mod.return(
            mod.call(
              "__are_types_compatible",
              [mod.local.get(4, rtt.base), mod.local.get(5, rtt.base)],
              binaryen.i32
            )
          ),
        ])
      ),

      // Else, return false
      mod.return(mod.i32.const(0)),
    ])
  );

  // Implementing __extends_nominal
  mod.addFunction(
    "__extends_nominal",
    binaryen.createType([rtt.base, binaryen.i32]), // Parameters: a_rtt (rtt.base), b_nominal_id (i32)
    binaryen.i32, // Result: i32 (boolean)
    [binaryen.i32, i32Array], // temp variables
    mod.block(null, [
      // Get a's nominal ID
      mod.local.set(2, getNominalId(0)),
      // If a_nominal_id == b_nominal_id, return true
      mod.if(
        mod.i32.eq(
          mod.local.get(2, binaryen.i32),
          mod.local.get(1, binaryen.i32)
        ),
        mod.return(mod.i32.const(1))
      ),
      // Get a's ancestors array
      mod.local.set(
        3,
        structGetFieldValue({
          mod,
          fieldType: rtt.nominalObject,
          fieldIndex: 1, // __ancestors
          exprRef: refCast(mod, mod.local.get(0, rtt.base), rtt.nominalObject),
        })
      ),
      // Call __extends(b_nominal_id, a_ancestors)
      mod.return(
        mod.call(
          "__extends",
          [mod.local.get(1, binaryen.i32), mod.local.get(3, i32Array)],
          binaryen.i32
        )
      ),
    ])
  );

  // Implementing __object_type_in_union
  mod.addFunction(
    "__object_type_in_union",
    binaryen.createType([rtt.base, rtt.base]),
    binaryen.i32,
    [
      binaryen.i32, // __union_length
      binaryen.i32, // index
      rtt.base, // union_type
      binaryen.i32, // result
    ],
    mod.block(null, [
      // Retrieve union types from `b`
      mod.local.set(
        2,
        structGetFieldValue({
          mod,
          fieldType: rtt.union,
          fieldIndex: 1, // __union_types
          exprRef: refCast(mod, mod.local.get(1, rtt.base), rtt.union),
        })
      ),
      // Get length of union types
      mod.local.set(0, arrayLen(mod, mod.local.get(2, rtt.unionTypes))),
      // Initialize index = 0
      mod.local.set(1, mod.i32.const(0)),
      mod.loop(
        "union_loop",
        mod.block("end_union_loop", [
          // if (index >= union_length) break;
          mod.if(
            mod.i32.ge_s(
              mod.local.get(1, binaryen.i32),
              mod.local.get(0, binaryen.i32)
            ),
            mod.br("end_union_loop")
          ),
          // Get union_type = union_types[index]
          mod.local.set(
            2,
            arrayGet(
              mod,
              mod.local.get(2, rtt.unionTypes),
              mod.local.get(1, binaryen.i32),
              rtt.base,
              false
            )
          ),
          // Check if typesAreCompatible(a, union_type)
          mod.local.set(
            3,
            mod.call(
              "__are_types_compatible",
              [mod.local.get(0, rtt.base), mod.local.get(2, rtt.base)],
              binaryen.i32
            )
          ),
          mod.if(
            mod.i32.eq(mod.local.get(3, binaryen.i32), mod.i32.const(1)),
            mod.return(mod.i32.const(1))
          ),
          // Increment index
          mod.local.set(
            1,
            mod.i32.add(mod.local.get(1, binaryen.i32), mod.i32.const(1))
          ),
          // Continue loop
          mod.br("union_loop"),
        ])
      ),
      // No matching type found, return false
      mod.return(mod.i32.const(0)),
    ])
  );

  // Implementing __unions_are_compatible
  mod.addFunction(
    "__unions_are_compatible",
    binaryen.createType([rtt.base, rtt.base]),
    binaryen.i32,
    [
      binaryen.i32, // a_length
      binaryen.i32, // i (a index)
      binaryen.i32, // b_length
      binaryen.i32, // j (b index)
      rtt.base, // a_type
      rtt.base, // b_type
      binaryen.i32, // found
    ],
    mod.block(null, [
      // Retrieve union types from `a`
      mod.local.set(
        0,
        structGetFieldValue({
          mod,
          fieldType: rtt.union,
          fieldIndex: 1, // __union_types
          exprRef: refCast(mod, mod.local.get(0, rtt.base), rtt.union),
        })
      ),
      // Get length of a's union types
      mod.local.set(1, arrayLen(mod, mod.local.get(0, rtt.unionTypes))),
      // Initialize i = 0
      mod.local.set(2, mod.i32.const(0)),
      mod.loop(
        "a_union_loop",
        mod.block("end_a_union_loop", [
          // if (i >= a_length) break;
          mod.if(
            mod.i32.ge_s(
              mod.local.get(2, binaryen.i32),
              mod.local.get(1, binaryen.i32)
            ),
            mod.br("end_a_union_loop")
          ),
          // Get a_type = a_union_types[i]
          mod.local.set(
            4,
            arrayGet(
              mod,
              mod.local.get(0, rtt.unionTypes),
              mod.local.get(2, binaryen.i32),
              rtt.base,
              false
            )
          ),
          // Retrieve union types from `b`
          mod.local.set(
            3,
            structGetFieldValue({
              mod,
              fieldType: rtt.union,
              fieldIndex: 1, // __union_types
              exprRef: refCast(mod, mod.local.get(1, rtt.base), rtt.union),
            })
          ),
          // Get length of b's union types
          mod.local.set(5, arrayLen(mod, mod.local.get(3, rtt.unionTypes))),
          // Initialize j = 0
          mod.local.set(6, mod.i32.const(0)),
          // Initialize found = false
          mod.local.set(7, mod.i32.const(0)),
          mod.loop(
            "b_union_loop",
            mod.block("end_b_union_loop", [
              // if (j >= b_length) break;
              mod.if(
                mod.i32.ge_s(
                  mod.local.get(6, binaryen.i32),
                  mod.local.get(5, binaryen.i32)
                ),
                mod.br("end_b_union_loop")
              ),
              // Get b_type = b_union_types[j]
              mod.local.set(
                5,
                arrayGet(
                  mod,
                  mod.local.get(3, rtt.unionTypes),
                  mod.local.get(6, binaryen.i32),
                  rtt.base,
                  false
                )
              ),
              // Check if typesAreCompatible(a_type, b_type)
              mod.local.set(
                8,
                mod.call(
                  "__are_types_compatible",
                  [mod.local.get(4, rtt.base), mod.local.get(5, rtt.base)],
                  binaryen.i32
                )
              ),
              mod.if(
                mod.i32.eq(mod.local.get(8, binaryen.i32), mod.i32.const(1)),
                mod.block(null, [
                  // Set found = true
                  mod.local.set(7, mod.i32.const(1)),
                  // Break b_union_loop
                  mod.br("end_b_union_loop"),
                ])
              ),
              // Increment j
              mod.local.set(
                6,
                mod.i32.add(mod.local.get(6, binaryen.i32), mod.i32.const(1))
              ),
              // Continue b_union_loop
              mod.br("b_union_loop"),
            ])
          ),
          // If not found, return false
          mod.if(
            mod.i32.eq(mod.local.get(7, binaryen.i32), mod.i32.const(0)),
            mod.return(mod.i32.const(0))
          ),
          // Increment i
          mod.local.set(
            2,
            mod.i32.add(mod.local.get(2, binaryen.i32), mod.i32.const(1))
          ),
          // Continue a_union_loop
          mod.br("a_union_loop"),
        ])
      ),
      // All types in a's union are compatible with at least one type in b's union
      mod.return(mod.i32.const(1)),
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
        if (type.isStructural) {
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

  const unionTypes = defineArrayType(mod, base, false, "__RttUnionTypes");

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
