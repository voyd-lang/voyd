import binaryen from "binaryen";
import { AugmentedBinaryen, ExpressionRef, Struct } from "./types.mjs";

const bin = binaryen as unknown as AugmentedBinaryen;

export const defineStructType = (mod: binaryen.Module, struct: Struct) => {
  const fields = struct.fields;
  const structIndex = 0;
  const typeBuilder = bin._TypeBuilderCreate(1);
  const tempStructHeapType = bin._TypeBuilderGetTempHeapType(
    typeBuilder,
    structIndex
  );

  const fieldTypesPtr = allocU32Array(fields.map(({ type }) => type));
  const fieldPackedTypesPtr = allocU32Array(
    fields.map(
      ({ packedType }) => packedType ?? bin._BinaryenPackedTypeNotPacked()
    )
  );
  const fieldMutablesPtr = allocU32Array(
    fields.map(({ mutable }) => (mutable ? 1 : 0))
  );

  bin._TypeBuilderSetStructType(
    typeBuilder,
    structIndex,
    fieldTypesPtr,
    fieldPackedTypesPtr,
    fieldMutablesPtr,
    fields.length
  );

  bin._free(fieldTypesPtr);
  bin._free(fieldPackedTypesPtr);
  bin._free(fieldMutablesPtr);

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

  fields.forEach(({ name }, index) => {
    if (!name) return;
    const ptr = allocString(name);
    bin._BinaryenModuleSetFieldName(mod.ptr, tempStructHeapType, index, ptr);
    bin._free(ptr);
  });

  if (struct.name) {
    const ptr = allocString(struct.name);
    bin._BinaryenModuleSetTypeName(mod.ptr, tempStructHeapType, ptr);
    bin._free(ptr);
  }

  return tempStructHeapType;
};

export const initStruct = (
  mod: binaryen.Module,
  structType: number,
  values: ExpressionRef[]
): ExpressionRef => {
  const structNewArgs = allocU32Array(values);
  const structNew = bin._BinaryenStructNew(
    mod.ptr,
    structNewArgs,
    values.length,
    structType
  );
  bin._free(structNewArgs);
  return structNew;
};

/** Returns a pointer to the allocated array */
const allocU32Array = (u32s: number[]): number => {
  const ptr = bin._malloc(u32s.length << 2); // Allocate memory
  u32s.forEach((value, index) => {
    bin.__i32_store(ptr + index * 4, value); // Store each value at the correct offset
  });
  return ptr;
};

// Function to pack 4 characters into a single 32-bit integer
const packCharsToU32 = (chars: string): number => {
  let packed = 0;
  for (let i = 0; i < chars.length; i++) {
    packed |= chars.charCodeAt(i) << (8 * i);
  }
  return packed;
};

// Function to convert string to array of packed 32-bit integers
const stringToPackedU32Array = (str: string): number[] => {
  const packedArray: number[] = [];
  for (let i = 0; i < str.length; i += 4) {
    const chunk = str.slice(i, i + 4);
    // Ensure that each chunk is packed into a 32-bit integer
    packedArray.push(packCharsToU32(chunk));
  }
  return packedArray;
};

// Function to allocate a string and return a pointer
const allocString = (str: string): number => {
  const packedArray = stringToPackedU32Array(str);
  return allocU32Array(packedArray);
};
