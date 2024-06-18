import { TypeBuilder, gc } from "binaryen-gc";
import binaryen from "binaryen";

export function internalTest() {
  // Simple Vec type { x: i32, y: i32, z: i32 }
  const builder = new TypeBuilder(1);

  builder.setStructType(0, [
    { type: binaryen.i32, packedType: 0, mutable: false },
    { type: binaryen.i32, packedType: 0, mutable: false },
    { type: binaryen.i32, packedType: 0, mutable: false },
  ]);

  const types = builder.buildAndDispose();

  const vecType = types.heapTypes[0];

  // Simple module with a function that returns a Vec, and a main function that reads the x value
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);

  // Simple function that returns a Vec
  mod.addFunction(
    "getVec",
    binaryen.none,
    binaryen.structref,
    [],
    mod.block(
      null,
      [
        gc.structs.newFromFields(mod, vecType, [
          mod.i32.const(1),
          mod.i32.const(2),
          mod.i32.const(3),
        ]),
      ],
      binaryen.auto
    )
  );

  // // Main function that reads the x value of the Vec
  mod.addFunction(
    "main",
    binaryen.none,
    binaryen.structref,
    [],
    mod.call("getVec", [], binaryen.structref)
  );

  mod.addFunctionExport("main", "main");

  mod.autoDrop();

  mod.validate();

  console.log(mod.emitText());
}
