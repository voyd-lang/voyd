import binaryen from "binaryen";
import { AugmentedBinaryen } from "@voyd/lib/binaryen-gc/types.js";
import {
  arrayGet,
  arrayLen,
  arrayNewFixed,
  binaryenTypeToHeapType,
  defineArrayType,
  defineStructType,
  initStruct,
  refCast,
  refFunc,
  structGetFieldValue,
  structSetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import { murmurHash3 } from "@voyd/lib/murmur-hash.js";

const bin = binaryen as unknown as AugmentedBinaryen;
const NON_REF_TYPES = new Set<number>([
  bin.none,
  bin.unreachable,
  bin.i32,
  bin.i64,
  bin.f32,
  bin.f64,
]);

const isRefType = (type: binaryen.Type): boolean =>
  binaryen.expandType(type).length === 1 && !NON_REF_TYPES.has(type);

const coerceAccessorExprType = ({
  mod,
  expr,
  targetType,
  baseType,
}: {
  mod: binaryen.Module;
  expr: binaryen.ExpressionRef;
  targetType: binaryen.Type;
  baseType: binaryen.Type;
}): binaryen.ExpressionRef => {
  const exprType = binaryen.getExpressionType(expr);
  if (exprType === targetType) {
    return expr;
  }
  if (
    targetType === baseType ||
    targetType === bin.anyref ||
    targetType === bin.eqref
  ) {
    return expr;
  }
  if (!isRefType(exprType) || !isRefType(targetType)) {
    return expr;
  }
  return refCast(mod, expr, targetType);
};

export const LOOKUP_FIELD_ACCESSOR = "__lookup_field_accessor";

export interface FieldAccessorField {
  name: string;
  wasmType: binaryen.Type;
  heapWasmType: binaryen.Type;
  runtimeIndex: number;
  hash?: number;
  getterType?: binaryen.Type;
  setterType?: binaryen.Type;
}

export interface RegisterFieldAccessorsOptions {
  typeLabel: string;
  runtimeType: binaryen.Type;
  baseType: binaryen.Type;
  fields: readonly FieldAccessorField[];
}

export interface FieldLookupHelpers {
  lookupTableType: binaryen.Type;
  registerType: (
    opts: RegisterFieldAccessorsOptions
  ) => binaryen.ExpressionRef;
}

export const initFieldLookupHelpers = (
  mod: binaryen.Module
): FieldLookupHelpers => {
  const tableByTypeLabel = new Map<string, binaryen.ExpressionRef>();
  const fieldAccessorStruct = defineStructType(mod, {
    name: "FieldAccessor",
    fields: [
      { name: "__field_hash", type: bin.i32, mutable: false },
      { name: "__field_getter", type: bin.funcref, mutable: false },
      { name: "__field_setter", type: bin.funcref, mutable: false },
    ],
  });
  const lookupTableType = defineArrayType(mod, fieldAccessorStruct, true);

  mod.addFunction(
    LOOKUP_FIELD_ACCESSOR,
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

  const registerType = (
    opts: RegisterFieldAccessorsOptions
  ): binaryen.ExpressionRef => {
    const cachedTable = tableByTypeLabel.get(opts.typeLabel);
    if (cachedTable) {
      return cachedTable;
    }
    const hashes = new Map<number, string>();
    const entries = opts.fields.map((field) => {
      const hash = murmurHash3(field.name);
      const existing = hashes.get(hash);
      if (existing && existing !== field.name) {
        throw new Error(
          [
            `field hash collision detected for ${opts.typeLabel}`,
            `hash: ${hash}`,
            `existing: ${existing}`,
            `new: ${field.name}`,
          ].join("\n")
        );
      }
      hashes.set(hash, field.name);
      field.hash = hash;

      const getterName = `obj_field_getter_${opts.typeLabel}_${field.name}`;
      const setterName = `obj_field_setter_${opts.typeLabel}_${field.name}`;

      const getter = mod.addFunction(
        getterName,
        bin.createType([opts.baseType]),
        field.heapWasmType,
        [],
        structGetFieldValue({
          mod,
          fieldType: field.heapWasmType,
          fieldIndex: field.runtimeIndex,
          exprRef: refCast(
            mod,
            mod.local.get(0, opts.baseType),
            opts.runtimeType
          ),
        })
      );

      const setter = mod.addFunction(
        setterName,
        bin.createType([opts.baseType, field.heapWasmType]),
        bin.none,
        [],
        structSetFieldValue({
          mod,
          fieldIndex: field.runtimeIndex,
          ref: refCast(
            mod,
            mod.local.get(0, opts.baseType),
            opts.runtimeType
          ),
          value: coerceAccessorExprType({
            mod,
            expr: mod.local.get(1, field.heapWasmType),
            targetType: field.heapWasmType,
            baseType: opts.baseType,
          }),
        })
      );

      const getterHeapType = bin._BinaryenFunctionGetType(getter);
      const getterType = bin._BinaryenTypeFromHeapType(getterHeapType, false);
      field.getterType = getterType;

      const setterHeapType = bin._BinaryenFunctionGetType(setter);
      const setterType = bin._BinaryenTypeFromHeapType(setterHeapType, false);
      field.setterType = setterType;

      return initStruct(mod, fieldAccessorStruct, [
        mod.i32.const(hash),
        refFunc(mod, getterName, getterType),
        refFunc(mod, setterName, setterType),
      ]);
    });

    const tableExpr = arrayNewFixed(
      mod,
      binaryenTypeToHeapType(lookupTableType),
      entries
    );
    tableByTypeLabel.set(opts.typeLabel, tableExpr);
    return tableExpr;
  };

  return {
    lookupTableType,
    registerType,
  };
};
