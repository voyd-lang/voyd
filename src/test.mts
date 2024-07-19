import binaryen from "binaryen";
import { AugmentedBinaryen } from "./lib/binaryen-gc/types.mjs";
import { defineStructType, initStruct } from "./lib/binaryen-gc/index.mjs";

const bin = binaryen as unknown as AugmentedBinaryen;

export function internalTest() {
  // Simple module with a function that returns a Vec, and a main function that reads the x value
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);

  // Simple Vec type { x: i32, y: i32, z: i32 };
  const vecType = defineStructType(mod, {
    name: "Vec",
    fields: [
      { name: "x", type: bin.i32, mutable: false },
      { name: "y", type: bin.i32, mutable: false },
      { name: "z", type: bin.i32, mutable: false },
    ],
  });

  const newStruct = initStruct(mod, vecType, [
    mod.i32.const(1),
    mod.i32.const(2),
    mod.i32.const(3),
  ]);

  // // // Main function that reads the x value of the Vec
  mod.addFunction(
    "main",
    bin.createType([]),
    bin.i32,
    [],
    bin._BinaryenStructGet(mod.ptr, 0, newStruct, bin.i32, false)
  );

  mod.addFunctionExport("main", "main");

  // Simple Vec type { x: i32, y: i32, z: i32 };
  const vecType2 = defineStructType(mod, {
    name: "Veca",
    fields: [
      { name: "x", type: bin.i32, mutable: false },
      { name: "y", type: bin.i32, mutable: false },
      { name: "z", type: bin.i32, mutable: false },
      { name: "f", type: bin.i32, mutable: false },
    ],
  });

  const newStruct2 = initStruct(mod, vecType2, [
    mod.i32.const(1),
    mod.i32.const(2),
    mod.i32.const(3),
  ]);

  // // // Main function that reads the x value of the Vec
  mod.addFunction(
    "main2",
    bin.createType([]),
    bin.i32,
    [],
    bin._BinaryenStructGet(mod.ptr, 0, newStruct2, bin.i32, false)
  );

  mod.addFunctionExport("main2", "main2");

  // mod.autoDrop();

  // mod.validate();

  console.log(mod.emitText());
}

export function internalTest2() {
  const mod = new binaryen.Module();

  const tempStructIndex = 0;
  const typeBuilder = bin._TypeBuilderCreate(1);
  // I always use temps so that I can potentially create recursive types.
  const tempStructHeapType = bin._TypeBuilderGetTempHeapType(
    typeBuilder,
    tempStructIndex
  );

  const fieldTypes = [bin.i32];
  const cFieldTypes = allocU32Array(fieldTypes);
  const cFieldPackedTypes = allocU32Array(
    fieldTypes.map(() => bin._BinaryenPackedTypeNotPacked())
  );
  const cFieldMutables = allocU32Array(fieldTypes.map(() => 0));
  bin._TypeBuilderSetStructType(
    typeBuilder,
    tempStructIndex,
    cFieldTypes,
    cFieldPackedTypes,
    cFieldMutables,
    fieldTypes.length
  );
  bin._free(cFieldTypes);
  bin._free(cFieldPackedTypes);
  bin._free(cFieldMutables);

  const size = bin._TypeBuilderGetSize(typeBuilder);
  const out = bin._malloc(Math.max(4 * size, 8));
  if (!bin._TypeBuilderBuildAndDispose(typeBuilder, out, out, out + 4)) {
    bin._free(out);
    throw new Error("_TypeBuilderBuildAndDispose failed");
  }
  // const structHeapType = bin.__i32_load(out + 4 * tempStructIndex);
  // const structBinaryenType = bin._BinaryenTypeFromHeapType(structHeapType, false);
  // const signatureHeapType = bin.__i32_load(out + 4 * tempSignatureIndex);
  bin._free(out);

  const structNewArgs = allocU32Array([mod.i32.const(1337)]);
  const structNew = bin._BinaryenStructNew(
    mod.ptr,
    structNewArgs,
    1,
    tempStructHeapType
  );
  bin._free(structNewArgs);

  mod.addFunction(
    "_start",
    bin.createType([]),
    bin.i32,
    [],
    bin._BinaryenStructGet(mod.ptr, 0, structNew, bin.i32, false)
  );

  mod.addFunctionExport("_start", "_start");

  console.log(mod.emitText());
}

function allocU32Array(u32s: number[]): number {
  const { length } = u32s;
  const ptr = bin._malloc(length << 2);
  let offset = ptr;
  for (let i = 0; i < length; i++) {
    const value = u32s[i];
    bin.__i32_store(offset, value);
    offset += 4;
  }
  return ptr;
}
