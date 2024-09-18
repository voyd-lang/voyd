import binaryen from "binaryen";
import { AugmentedBinaryen } from "../lib/binaryen-gc/types.js";
import {
  defineArrayType,
  arrayLen,
  arrayGet,
  arrayNewFixed,
  binaryenTypeToHeapType,
} from "../lib/binaryen-gc/index.js";

const bin = binaryen as unknown as AugmentedBinaryen;

/** DOES NOT ACCOUNT FOR FIELD OFFSET */
export const initFieldLookupHelpers = (mod: binaryen.Module) => {
  const lookupTableType = defineArrayType(mod, bin.i32, true);
  const LOOKUP_NAME = "__lookup_field_index";

  mod.addFunction(
    LOOKUP_NAME,
    // Field hash int, Field lookup table
    bin.createType([bin.i32, lookupTableType]),
    bin.i32,
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
              arrayGet(
                mod,
                mod.local.get(1, lookupTableType),
                mod.local.get(2, bin.i32),
                bin.i32,
                false
              )
            ),

            // If we have return the current index, as it matches the field index
            mod.return(mod.local.get(2, bin.i32))
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

  const initFieldIndexTable = (fields: number[]) => {
    return arrayNewFixed(
      mod,
      binaryenTypeToHeapType(lookupTableType),
      fields.map((id) => mod.i32.const(id))
    );
  };

  return { initFieldIndexTable, lookupTableType, LOOKUP_NAME };
};
