import binaryen from "binaryen";
import { AugmentedBinaryen } from "./types.mjs";
import {
  binaryenTypeToHeapType,
  defineStructType,
  initStruct,
  structGetFieldValue,
} from ".//index.mjs";

const bin = binaryen as unknown as AugmentedBinaryen;

export function testGc() {
  // Simple module with a function that returns a Vec, and a main function that reads the x value
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);

  const dotType = defineStructType(mod, {
    name: "Dot",
    fields: [
      { name: "a", type: bin.i32, mutable: false },
      { name: "b", type: bin.i32, mutable: false },
    ],
  });

  const dotTypeRef = binaryenTypeToHeapType(dotType);

  const vecType = defineStructType(mod, {
    name: "Vec",
    fields: [
      { name: "x", type: bin.i32, mutable: true },
      { name: "y", type: bin.i32, mutable: false },
      { name: "z", type: dotType, mutable: false },
    ],
  });

  const vecTypeRef = binaryenTypeToHeapType(vecType);

  const newStruct = initStruct(mod, vecTypeRef, [
    mod.i32.const(1),
    mod.i32.const(2),
    initStruct(mod, dotTypeRef, [mod.i32.const(1), mod.i32.const(2)]),
  ]);

  // Main function that reads the x value of the Vec
  mod.addFunction(
    "main",
    bin.createType([]),
    bin.i32,
    [vecType],
    mod.block(null, [
      mod.local.set(0, newStruct),
      structGetFieldValue({
        mod,
        fieldIndex: 1,
        fieldType: bin.i32,
        exprRef: structGetFieldValue({
          mod,
          fieldIndex: 2,
          fieldType: dotType,
          exprRef: mod.local.get(0, vecType),
        }),
      }),
    ])
  );

  mod.addFunctionExport("main", "main");

  mod.autoDrop();

  mod.validate();

  console.log(mod.emitText());
}
