import binaryen from "binaryen";
import { AugmentedBinaryen } from "./types.js";
import {
  arrayGet,
  arrayLen,
  arrayNew,
  arrayNewFixed,
  arraySet,
  binaryenTypeToHeapType,
  defineArrayType,
} from "./index.js";
import { run } from "../../run.js";

const bin = binaryen as unknown as AugmentedBinaryen;

export function testGc() {
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);

  const i32Array = defineArrayType(mod, bin.i32, true);

  const initExtensionArray = (ancestorIds: number[]) => {
    return arrayNewFixed(
      mod,
      binaryenTypeToHeapType(i32Array),
      ancestorIds.map((id) => mod.i32.const(id))
    );
  };

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

  mod.addGlobal(
    "extensionArray",
    i32Array,
    false,
    initExtensionArray([1, 2, 3])
  );

  mod.addFunction(
    "main",
    bin.createType([]),
    bin.i32,
    [i32Array],
    mod.block(null, [
      mod.local.set(0, initExtensionArray([1, 2, 3])),
      mod.call(
        "__extends",
        [mod.i32.const(4), mod.global.get("extensionArray", i32Array)],
        bin.i32
      ),
    ])
  );

  mod.addFunctionExport("main", "main");
  mod.autoDrop();
  mod.validate();

  // console.log(mod.emitText());
  run(mod);
}
