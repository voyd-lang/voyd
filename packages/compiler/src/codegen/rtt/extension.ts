import binaryen from "binaryen";
import type { AugmentedBinaryen } from "@voyd/lib/binaryen-gc/types.js";
import {
  arrayGet,
  arrayLen,
  arrayNewFixed,
  binaryenTypeToHeapType,
  defineArrayType,
} from "@voyd/lib/binaryen-gc/index.js";

const bin = binaryen as unknown as AugmentedBinaryen;

type ExtensionHelpers = {
  i32Array: binaryen.Type;
  initExtensionArray: (ancestorIds: readonly number[]) => binaryen.ExpressionRef;
};

export const initExtensionHelpers = (mod: binaryen.Module): ExtensionHelpers => {
  const i32Array = defineArrayType(mod, bin.i32, true);

  const initExtensionArray = (ancestorIds: readonly number[]) =>
    arrayNewFixed(
      mod,
      binaryenTypeToHeapType(i32Array),
      ancestorIds.map((id) => mod.i32.const(id))
    );

  mod.addFunction(
    "__extends",
    bin.createType([bin.i32, i32Array]),
    bin.i32,
    [bin.i32, bin.i32],
    mod.block(
      null,
      [
        mod.local.set(2, mod.i32.const(0)),
        mod.local.set(3, mod.i32.const(0)),
        mod.block("break", [
          mod.loop(
            "loop",
            mod.block(null, [
              mod.br_if(
                "break",
                mod.i32.eq(
                  mod.local.get(2, bin.i32),
                  arrayLen(mod, mod.local.get(1, i32Array))
                )
              ),
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
                mod.block(null, [
                  mod.local.set(3, mod.i32.const(1)),
                  mod.br("break"),
                ])
              ),
              mod.local.set(
                2,
                mod.i32.add(mod.local.get(2, bin.i32), mod.i32.const(1))
              ),
              mod.br("loop"),
            ])
          ),
        ]),
        mod.local.get(3, bin.i32),
      ],
      bin.i32
    )
  );

  mod.addFunction(
    "__has_type",
    bin.createType([bin.i32, i32Array]),
    bin.i32,
    [],
    mod.if(
      mod.i32.eq(arrayLen(mod, mod.local.get(1, i32Array)), mod.i32.const(0)),
      mod.i32.const(0),
      mod.i32.eq(
        mod.local.get(0, bin.i32),
        arrayGet(
          mod,
          mod.local.get(1, i32Array),
          mod.i32.const(0),
          bin.i32,
          false
        )
      )
    )
  );

  return { i32Array, initExtensionArray };
};
