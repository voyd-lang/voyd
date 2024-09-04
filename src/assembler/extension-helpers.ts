import binaryen from "binaryen";
import { AugmentedBinaryen } from "../lib/binaryen-gc/types.js";
import {
  defineArrayType,
  arrayNew,
  binaryenTypeToHeapType,
  arraySet,
  arrayLen,
  arrayGet,
} from "../lib/binaryen-gc/index.js";

const bin = binaryen as unknown as AugmentedBinaryen;

export const initExtensionHelpers = (mod: binaryen.Module) => {
  const i32Array = defineArrayType(mod, bin.i32, true);

  mod.addGlobal(
    "__extensionArrayConstructor",
    i32Array,
    true,
    arrayNew(
      mod,
      binaryenTypeToHeapType(i32Array),
      mod.i32.const(0),
      mod.i32.const(0)
    )
  );

  mod.addFunction(
    "__extends",
    // Extension Obj Id, Ancestor Ids Array
    bin.createType([bin.i32, i32Array]),
    bin.i32,
    [bin.i32, bin.i32], // Current index, Does Extend
    mod.block(null, [
      mod.local.set(2, mod.i32.const(0)), // Current ancestor index
      mod.local.set(3, mod.i32.const(0)), // Does extend
      mod.block("break", [
        mod.loop(
          "loop",
          mod.block(null, [
            // Break if we've reached the end of the ancestors
            mod.br_if(
              "break",
              mod.i32.eq(
                mod.local.get(2, bin.i32),
                arrayLen(mod, mod.local.get(1, i32Array))
              )
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
              mod.block(null, [
                mod.local.set(3, mod.i32.const(1)),
                mod.br("break"),
              ])
            ),

            // Increment ancestor index
            mod.local.set(
              2,
              mod.i32.add(mod.local.get(2, bin.i32), mod.i32.const(1))
            ),
            mod.br("loop"),
          ])
        ),
      ]),
      mod.local.get(3, bin.i32),
    ])
  );

  const initExtensionArray = (ancestorIds: number[]) => {
    const init = arrayNew(
      mod,
      binaryenTypeToHeapType(i32Array),
      mod.i32.const(ancestorIds.length),
      mod.i32.const(0)
    );

    return mod.block(null, [
      mod.global.set("__extensionArrayConstructor", init),
      ...ancestorIds.map((id, i) =>
        arraySet(
          mod,
          mod.global.get("__extensionArrayConstructor", i32Array),
          mod.i32.const(i),
          mod.i32.const(id)
        )
      ),
      mod.global.get("__extensionArrayConstructor", i32Array),
    ]);
  };

  return { initExtensionArray, i32Array };
};
