import binaryen from "binaryen";
import { AugmentedBinaryen } from "../../lib/binaryen-gc/types.js";
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
  structSetFieldValue,
} from "../../lib/binaryen-gc/index.js";
import {
  IntersectionType,
  ObjectType,
  voydBaseObject,
} from "../../syntax-objects/types.js";
import { murmurHash3 } from "../../lib/murmur-hash.js";
import {
  compileExpression,
  CompileExprOpts,
  mapBinaryenType,
} from "../../codegen.js";
import { Call } from "../../syntax-objects/call.js";

const bin = binaryen as unknown as AugmentedBinaryen;

export const initFieldLookupHelpers = (mod: binaryen.Module) => {
  const fieldAccessorStruct = defineStructType(mod, {
    name: "FieldAccessor",
    fields: [
      { name: "__field_hash", type: bin.i32, mutable: false },
      { name: "__field_getter", type: bin.funcref, mutable: false },
      { name: "__field_setter", type: bin.funcref, mutable: false },
    ],
  });
  const lookupTableType = defineArrayType(mod, fieldAccessorStruct, true);
  const LOOKUP_NAME = "__lookup_field_accessor";

  mod.addFunction(
    LOOKUP_NAME,
    // Field hash int, Field lookup table, getterOrSetter 0 = getter, 1 = setter
    bin.createType([bin.i32, lookupTableType, bin.i32]),
    bin.funcref, // Field accessor
    [bin.i32], // Current index parameter
    mod.block(null, [
      mod.local.set(3, mod.i32.const(0)), // Current field index
      mod.loop(
        "loop",
        mod.block(null, [
          // Trap if we've reached the end of the field table, the compiler messed up
          mod.if(
            mod.i32.eq(
              mod.local.get(3, bin.i32),
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
                  mod.local.get(3, bin.i32),
                  fieldAccessorStruct,
                  false
                ),
              })
            ),

            // If we have, return the appropriate getter or setter
            mod.return(
              mod.if(
                mod.i32.eq(mod.local.get(2, bin.i32), mod.i32.const(0)),
                structGetFieldValue({
                  mod,
                  fieldType: bin.funcref,
                  fieldIndex: 1,
                  exprRef: arrayGet(
                    mod,
                    mod.local.get(1, lookupTableType),
                    mod.local.get(3, bin.i32),
                    fieldAccessorStruct,
                    false
                  ),
                }),
                structGetFieldValue({
                  mod,
                  fieldType: bin.funcref,
                  fieldIndex: 2,
                  exprRef: arrayGet(
                    mod,
                    mod.local.get(1, lookupTableType),
                    mod.local.get(3, bin.i32),
                    fieldAccessorStruct,
                    false
                  ),
                })
              )
            )
          ),

          // Increment ancestor index
          mod.local.set(
            3,
            mod.i32.add(mod.local.get(3, bin.i32), mod.i32.const(1))
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
        const getterName = `obj_field_getter_${obj.id}_${field.name}`;
        const setterName = `obj_field_setter_${obj.id}_${field.name}`;

        const getter = mod.addFunction(
          getterName,
          bin.createType([mapBinaryenType(opts, voydBaseObject)]),
          mapBinaryenType(opts, field.type!),
          [],
          structGetFieldValue({
            mod,
            fieldType: mapBinaryenType(opts, field.type!),
            fieldIndex: index + 3, // Skip RTT type fields
            exprRef: refCast(
              mod,
              mod.local.get(0, mapBinaryenType(opts, voydBaseObject)),
              mapBinaryenType(opts, obj)
            ),
          })
        );

        const setter = mod.addFunction(
          setterName,
          bin.createType([
            mapBinaryenType(opts, voydBaseObject),
            mapBinaryenType(opts, field.type!),
          ]),
          bin.none,
          [],
          structSetFieldValue({
            mod,
            fieldIndex: index + 3, // Skip RTT type fields
            ref: refCast(
              mod,
              mod.local.get(0, mapBinaryenType(opts, voydBaseObject)),
              mapBinaryenType(opts, obj)
            ),
            value: mod.local.get(1, mapBinaryenType(opts, field.type!)),
          })
        );

        const getterHeapType = bin._BinaryenFunctionGetType(getter);
        const getterType = bin._BinaryenTypeFromHeapType(getterHeapType, false);

        const setterHeapType = bin._BinaryenFunctionGetType(setter);
        const setterType = bin._BinaryenTypeFromHeapType(setterHeapType, false);

        field.binaryenGetterType = getterType;
        field.binaryenSetterType = setterType;

        return initStruct(mod, fieldAccessorStruct, [
          mod.i32.const(murmurHash3(field.name)),
          refFunc(mod, getterName, getterType),
          refFunc(mod, setterName, setterType),
        ]);
      })
    );
  };

  const getFieldValueByAccessor = (opts: CompileExprOpts<Call>) => {
    const { expr, mod } = opts;
    const obj = expr.exprArgAt(0);
    const member = expr.identifierArgAt(1);
    const objType = obj.getType() as ObjectType | IntersectionType;

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
      exprRef: compileExpression({ ...opts, expr: obj, isReturnExpr: true }),
    });

    const funcRef = mod.call(
      LOOKUP_NAME,
      [mod.i32.const(murmurHash3(member.value)), lookupTable, mod.i32.const(0)],
      bin.funcref
    );

    return callRef(
      mod,
      refCast(mod, funcRef, field.binaryenGetterType!),
      [compileExpression({ ...opts, expr: obj, isReturnExpr: true })],
      mapBinaryenType(opts, field.type!)
    );
  };

  const setFieldValueByAccessor = (opts: CompileExprOpts<Call>) => {
    const { expr, mod } = opts;
    const access = expr.callArgAt(0);
    const member = access.identifierArgAt(1);
    const target = access.exprArgAt(0);
    const value = compileExpression({
      ...opts,
      expr: expr.argAt(1)!,
      isReturnExpr: true,
    });
    const objType = target.getType() as ObjectType | IntersectionType;

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
      exprRef: compileExpression({ ...opts, expr: target, isReturnExpr: true }),
    });

    const funcRef = mod.call(
      LOOKUP_NAME,
      [mod.i32.const(murmurHash3(member.value)), lookupTable, mod.i32.const(1)],
      bin.funcref
    );

    return callRef(
      mod,
      refCast(mod, funcRef, field.binaryenSetterType!),
      [compileExpression({ ...opts, expr: target, isReturnExpr: true }), value],
      mapBinaryenType(opts, field.type!)
    );
  };

  return {
    initFieldIndexTable,
    lookupTableType,
    LOOKUP_NAME,
    getFieldValueByAccessor,
    setFieldValueByAccessor,
  };
};
