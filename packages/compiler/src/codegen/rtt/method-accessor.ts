import binaryen from "binaryen";
import {
  arrayGet,
  arrayLen,
  arrayNewFixed,
  binaryenTypeToHeapType,
  defineArrayType,
  defineStructType,
  initStruct,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";

export const LOOKUP_METHOD_ACCESSOR = "__lookup_method_accessor";

export interface MethodAccessorEntry {
  hash: number;
  ref: binaryen.ExpressionRef;
}

export interface MethodLookupHelpers {
  lookupTableType: binaryen.Type;
  createTable(entries: readonly MethodAccessorEntry[]): binaryen.ExpressionRef;
}

export const initMethodLookupHelpers = (
  mod: binaryen.Module
): MethodLookupHelpers => {
  const methodAccessorStruct = defineStructType(mod, {
    name: "MethodAccessor",
    fields: [
      { name: "__method_hash", type: binaryen.i32, mutable: false },
      { name: "__method_ref", type: binaryen.funcref, mutable: false },
    ],
  });
  const lookupTableType = defineArrayType(mod, methodAccessorStruct, true);

  mod.addFunction(
    LOOKUP_METHOD_ACCESSOR,
    binaryen.createType([binaryen.i32, lookupTableType]),
    binaryen.funcref,
    [binaryen.i32],
    mod.block(null, [
      mod.local.set(2, mod.i32.const(0)),
      mod.loop(
        "loop",
        mod.block(null, [
          mod.if(
            mod.i32.eq(
              mod.local.get(2, binaryen.i32),
              arrayLen(mod, mod.local.get(1, lookupTableType))
            ),
            mod.unreachable()
          ),
          mod.if(
            mod.i32.eq(
              mod.local.get(0, binaryen.i32),
              structGetFieldValue({
                mod,
                fieldType: binaryen.i32,
                fieldIndex: 0,
                exprRef: arrayGet(
                  mod,
                  mod.local.get(1, lookupTableType),
                  mod.local.get(2, binaryen.i32),
                  methodAccessorStruct,
                  false
                ),
              })
            ),
            mod.return(
              structGetFieldValue({
                mod,
                fieldType: binaryen.funcref,
                fieldIndex: 1,
                exprRef: arrayGet(
                  mod,
                  mod.local.get(1, lookupTableType),
                  mod.local.get(2, binaryen.i32),
                  methodAccessorStruct,
                  false
                ),
              })
            )
          ),
          mod.local.set(
            2,
            mod.i32.add(mod.local.get(2, binaryen.i32), mod.i32.const(1))
          ),
          mod.br("loop"),
        ])
      ),
    ])
  );

  const createTable = (
    entries: readonly MethodAccessorEntry[]
  ): binaryen.ExpressionRef => {
    return arrayNewFixed(
      mod,
      binaryenTypeToHeapType(lookupTableType),
      entries.map((entry) =>
        initStruct(mod, methodAccessorStruct, [
          mod.i32.const(entry.hash),
          entry.ref,
        ])
      )
    );
  };

  return { lookupTableType, createTable };
};
