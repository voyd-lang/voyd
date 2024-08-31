import binaryen from "binaryen";
import { AugmentedBinaryen } from "./types.js";
import {
  binaryenTypeToHeapType,
  defineStructType,
  initStruct,
  refCast,
  structGetFieldValue,
} from "./index.js";
import { run } from "../../run.js";

const bin = binaryen as unknown as AugmentedBinaryen;

// Structural sub-typing experiment
export function testGc() {
  // Simple module with a function that returns a Vec, and a main function that reads the x value
  const mod = new binaryen.Module();
  mod.setFeatures(binaryen.Features.All);

  // type Object = {};
  // type A = { a: i32 };
  // type B = { b: i32 };
  // type Vec = { a: i32; b: i32 };

  const objectType = defineStructType(mod, {
    name: "Object",
    fields: [],
  });

  const objectTypeRef = binaryenTypeToHeapType(objectType);

  const aType = defineStructType(mod, {
    name: "A",
    fields: [{ name: "a", type: bin.i32, mutable: false }],
    supertype: objectTypeRef,
  });

  const aTypeRef = binaryenTypeToHeapType(objectType);

  const bType = defineStructType(mod, {
    name: "B",
    fields: [{ name: "b", type: bin.i32, mutable: false }],
    supertype: objectTypeRef,
  });

  const bTypeRef = binaryenTypeToHeapType(bType);

  const vecType = defineStructType(mod, {
    name: "Vec",
    fields: [
      { name: "a", type: bin.i32, mutable: false },
      { name: "b", type: bin.i32, mutable: false },
    ],
    supertype: objectTypeRef,
  });

  const vecTypeRef = binaryenTypeToHeapType(vecType);

  const vec = initStruct(mod, vecTypeRef, [mod.i32.const(1), mod.i32.const(1)]);

  mod.addFunction(
    "castVec",
    bin.createType([bType]),
    vecType,
    [],
    mod.block(null, [refCast(mod, mod.local.get(0, bType), vecType)])
  );

  mod.addFunction(
    "main",
    bin.createType([]),
    bin.i32,
    [bin.anyref],
    mod.block(null, [
      mod.local.set(0, vec),
      structGetFieldValue({
        mod,
        fieldIndex: 0,
        fieldType: bin.i32,
        exprRef: refCast(mod, mod.local.get(0, bin.anyref), bType),
      }),
    ])
  );

  mod.addFunctionExport("main", "main");
  mod.autoDrop();
  mod.validate();

  console.log(mod.emitText());
  run(mod);
}

export function testGcOld() {
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

  const spotType = defineStructType(mod, {
    name: "Spot",
    fields: [
      { name: "a", type: bin.i32, mutable: false },
      { name: "b", type: bin.i32, mutable: false },
      { name: "c", type: bin.i32, mutable: false },
    ],
    supertype: dotTypeRef,
  });

  const spotTypeRef = binaryenTypeToHeapType(spotType);

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
    initStruct(mod, spotTypeRef, [
      mod.i32.const(1),
      mod.i32.const(2),
      mod.i32.const(2),
    ]),
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
  run(mod);
}
