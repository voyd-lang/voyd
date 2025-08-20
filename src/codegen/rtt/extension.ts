import binaryen from "binaryen";
import { AugmentedBinaryen } from "../../lib/binaryen-gc/types.js";
import {
  defineArrayType,
  arrayLen,
  arrayGet,
  arrayNewFixed,
  binaryenTypeToHeapType,
} from "../../lib/binaryen-gc/index.js";

const bin = binaryen as unknown as AugmentedBinaryen;

export const initExtensionHelpers = (mod: binaryen.Module) => {
  const i32Array = defineArrayType(mod, bin.i32, true);

  mod.addFunction(
    "__extends",
    // Extension Obj Id, Ancestor Ids Array
    bin.createType([bin.i32, i32Array]),
    bin.i32,
    [bin.i32], // Current index, Does Extend
    mod.block(null, [
      mod.local.set(2, mod.i32.const(0)), // Current ancestor index
      mod.loop(
        "loop",
        mod.block(null, [
          // We've reached the end of the ancestor table without finding a match, return false
          mod.if(
            mod.i32.eq(
              mod.local.get(2, bin.i32),
              arrayLen(mod, mod.local.get(1, i32Array))
            ),
            mod.return(mod.i32.const(0))
          ),

          // Check if we've found the ancestor
          mod.if(
            mod.i32.eq(
              mod.local.get(0, bin.i32),
              arrayGet(
                mod,
                mod.local.get(1, i32Array),
                mod.local.get(2, bin.i32),
                bin.i32,
                false
              )
            ),

            // If we have, set doesExtend to true and break
            mod.return(mod.i32.const(1))
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

  const initExtensionArray = (ancestorIds: number[]) => {
    return arrayNewFixed(
      mod,
      binaryenTypeToHeapType(i32Array),
      ancestorIds.map((id) => mod.i32.const(id))
    );
  };

  return { initExtensionArray, i32Array };
};
