import binaryen from "binaryen";
import { AugmentedBinaryen, ExpressionRef, Struct } from "./types.mjs";

const bin = binaryen as unknown as AugmentedBinaryen;

export const defineStructType = (struct: Struct) => {
  const structIndex = 0;
  const typeBuilder = bin._TypeBuilderCreate(1);
  const tempStructHeapType = bin._TypeBuilderGetTempHeapType(
    typeBuilder,
    structIndex
  );

  const fieldTypesPtr = allocU32Array(struct.map(({ type }) => type));
  const fieldPackedTypesPtr = allocU32Array(
    struct.map(
      ({ packedType }) => packedType ?? bin._BinaryenPackedTypeNotPacked()
    )
  );
  const fieldMutablesPtr = allocU32Array(
    struct.map(({ mutable }) => (mutable ? 1 : 0))
  );

  bin._TypeBuilderSetStructType(
    typeBuilder,
    structIndex,
    fieldTypesPtr,
    fieldPackedTypesPtr,
    fieldMutablesPtr,
    struct.length
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
  const ptr = bin._malloc(u32s.length << 2);
  u32s.reduce((offset, value) => {
    bin.__i32_store(offset, value);
    return offset + 4;
  }, ptr);
  return ptr;
};
