import binaryen from "binaryen";
import {
  AugmentedBinaryen,
  ExpressionRef,
  HeapTypeRef,
  Struct,
  Type,
} from "./types.js";

const bin = binaryen as unknown as AugmentedBinaryen;

export const defineStructType = (mod: binaryen.Module, struct: Struct) => {
  const fields = struct.fields;
  const structIndex = 0;
  const typeBuilder = bin._TypeBuilderCreate(1);

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

  const result = bin.__i32_load(out);
  bin._free(out);

  annotateStructNames(mod, result, struct);

  return bin._BinaryenTypeFromHeapType(result, false);
};

export const binaryenTypeToHeapType = (type: Type): HeapTypeRef => {
  return bin._BinaryenTypeGetHeapType(type);
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

export const structGetFieldValue = ({
  mod,
  fieldType,
  fieldIndex,
  exprRef,
  signed,
}: {
  mod: binaryen.Module;
  fieldType: number;
  fieldIndex: number;
  exprRef: ExpressionRef;
  signed?: boolean;
}): ExpressionRef => {
  return bin._BinaryenStructGet(
    mod.ptr,
    fieldIndex,
    exprRef,
    fieldType,
    !!signed
  );
};

/** Returns a pointer to the allocated array */
const allocU32Array = (u32s: number[]): number => {
  const ptr = bin._malloc(u32s.length << 2);
  bin.HEAPU32.set(u32s, ptr >>> 2);
  return ptr;
};

const annotateStructNames = (
  mod: binaryen.Module,
  typeRef: HeapTypeRef,
  struct: Struct
) => {
  struct.fields.forEach(({ name }, index) => {
    if (!name) return;
    bin._BinaryenModuleSetFieldName(
      mod.ptr,
      typeRef,
      index,
      bin.stringToUTF8OnStack(name)
    );
  });

  if (struct.name) {
    bin._BinaryenModuleSetTypeName(
      mod.ptr,
      typeRef,
      bin.stringToUTF8OnStack(struct.name)
    );
  }
};
