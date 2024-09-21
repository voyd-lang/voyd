import binaryen from "binaryen";
import { AugmentedBinaryen } from "../lib/binaryen-gc/types.js";
import {
  defineArrayType,
  arrayLen,
  arrayGet,
  arrayNewFixed,
  binaryenTypeToHeapType,
  defineStructType,
  initStruct,
  structGetFieldValue,
  refFunc,
  callRef,
  refCast,
} from "../lib/binaryen-gc/index.js";
import {
  IntersectionType,
  ObjectType,
  voidBaseObject,
} from "../syntax-objects/types.js";
import { murmurHash3 } from "../lib/murmur-hash.js";
import {
  compileExpression,
  CompileExprOpts,
  mapBinaryenType,
} from "../assembler.js";
import { Call } from "../syntax-objects/call.js";
import { getExprType } from "../semantics/resolution/get-expr-type.js";

const bin = binaryen as unknown as AugmentedBinaryen;

/** DOES NOT ACCOUNT FOR FIELD OFFSET */
export const initFieldLookupHelpers = (mod: binaryen.Module) => {
  const fieldAccessorStruct = defineStructType(mod, {
    name: "FieldAccessor",
    fields: [
      { name: "__field_hash", type: bin.i32, mutable: false },
      { name: "__field_accessor", type: bin.funcref, mutable: false },
    ],
  });
  const lookupTableType = defineArrayType(mod, fieldAccessorStruct, true);
  const LOOKUP_NAME = "__lookup_field_accessor";

  mod.addFunction(
    LOOKUP_NAME,
    // Field hash int, Field lookup table
    bin.createType([bin.i32, lookupTableType]),
    bin.funcref, // Field accessor
    [bin.i32], // Current index parameter
    mod.block(null, [
      mod.local.set(2, mod.i32.const(0)), // Current field index
      mod.loop(
        "loop",
        mod.block(null, [
          // Trap if we've reached the end of the field table, the compiler messed up
          mod.if(
            mod.i32.eq(
              mod.local.get(2, bin.i32),
              arrayLen(mod, mod.local.get(1, lookupTableType))
            ),
            mod.unreachable()
          ),

          // Check if we've found the field
          mod.if(
            mod.i32.eq(
              mod.local.get(0, bin.i32),
              structGetFieldValue({
                mod,
                fieldType: bin.i32,
                fieldIndex: 0,
                exprRef: arrayGet(
                  mod,
                  mod.local.get(1, lookupTableType),
                  mod.local.get(2, bin.i32),
                  bin.i32,
                  false
                ),
              })
            ),

            // If we have return the accessor function
            mod.return(
              structGetFieldValue({
                mod,
                fieldType: bin.funcref,
                fieldIndex: 1,
                exprRef: arrayGet(
                  mod,
                  mod.local.get(1, lookupTableType),
                  mod.local.get(2, bin.i32),
                  bin.i32,
                  false
                ),
              })
            )
          ),

          // Increment ancestor index
          mod.local.set(
            2,
            mod.i32.add(mod.local.get(2, bin.i32), mod.i32.const(1))
          ),
          mod.br("loop"),
        ])
      ),
    ])
  );

  const initFieldIndexTable = (opts: CompileExprOpts<ObjectType>) => {
    const { mod, expr: obj } = opts;
    return arrayNewFixed(
      mod,
      binaryenTypeToHeapType(lookupTableType),
      obj.fields.map((field, index) => {
        const accessorName = `obj_field_accessor_${obj.id}_${field.name}`;

        const accessor = mod.addFunction(
          accessorName,
          bin.createType([mapBinaryenType(opts, voidBaseObject)]),
          mapBinaryenType(opts, field.type!),
          [],
          structGetFieldValue({
            mod,
            fieldType: mapBinaryenType(opts, field.type!),
            fieldIndex: index + 2, // Skip RTT type fields
            exprRef: refCast(
              mod,
              mod.local.get(0, mapBinaryenType(opts, voidBaseObject)),
              mapBinaryenType(opts, obj)
            ),
          })
        );

        const funcHeapType = bin._BinaryenFunctionGetType(accessor);
        const funcType = bin._BinaryenTypeFromHeapType(funcHeapType, false);

        field.binaryenAccessorType = funcType;

        return initStruct(mod, fieldAccessorStruct, [
          mod.i32.const(murmurHash3(field.name)),
          refFunc(mod, accessorName, funcType),
        ]);
      })
    );
  };

  const getFieldValueByAccessor = (opts: CompileExprOpts<Call>) => {
    const { expr, mod } = opts;
    const obj = expr.exprArgAt(0);
    const member = expr.identifierArgAt(1);
    const objType = getExprType(obj) as ObjectType | IntersectionType;

    const field = objType.isIntersectionType()
      ? objType.nominalType?.getField(member) ??
        objType.structuralType?.getField(member)
      : objType.getField(member);

    if (!field) {
      throw new Error(
        `Field ${member.value} not found on object ${objType.id}`
      );
    }

    const lookupTable = structGetFieldValue({
      mod,
      fieldType: lookupTableType,
      fieldIndex: 1,
      exprRef: compileExpression({ ...opts, expr: obj }),
    });

    const funcRef = mod.call(
      LOOKUP_NAME,
      [mod.i32.const(murmurHash3(member.value)), lookupTable],
      bin.funcref
    );

    return callRef(
      mod,
      refCast(mod, funcRef, field.binaryenAccessorType!),
      [compileExpression({ ...opts, expr: obj })],
      mapBinaryenType(opts, field.type!)
    );
  };

  return {
    initFieldIndexTable,
    lookupTableType,
    LOOKUP_NAME,
    getFieldValueByAccessor,
  };
};
