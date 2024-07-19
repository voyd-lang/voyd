# Example Usage

```ts
import binaryen from "binaryen";
import { AugmentedBinaryen } from "./lib/binaryen-gc/types.mjs";
import {
  defineStructType,
  initStruct,
  structGetFieldValue,
} from "./lib/binaryen-gc/index.mjs";

const bin = binaryen as unknown as AugmentedBinaryen;

export function main() {
  // Simple module with a function that returns a Vec, and a main function that reads the x value
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);
  // Simple Vec type { x: i32, y: i32, z: i32 };
  const vecType = defineStructType(mod, {
    name: "Vec",
    fields: [
      { name: "x", type: bin.i32, mutable: true },
      { name: "y", type: bin.i32, mutable: false },
      { name: "z", type: bin.i32, mutable: false },
    ],
  });
  const vecTypeRef = bin._BinaryenTypeGetHeapType(vecType);

  const newStruct = initStruct(mod, vecTypeRef, [
    mod.i32.const(1),
    mod.i32.const(2),
    mod.i32.const(3),
  ]);

  // // // Main function that reads the x value of the Vec
  mod.addFunction(
    "main",
    bin.createType([vecType]),
    bin.i32,
    [],
    bin._BinaryenStructGet(
      mod.ptr,
      0,
      mod.local.get(0, vecType),
      bin.i32,
      false
    )
  );

  mod.addFunctionExport("main", "main");

  mod.autoDrop();

  mod.validate();

  console.log(mod.emitText());
}
```
