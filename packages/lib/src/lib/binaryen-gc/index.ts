import binaryen from "binaryen";
import {
  AugmentedBinaryen,
  ExpressionRef,
  HeapTypeRef,
  Struct,
  Type,
  TypeRef,
} from "./types.js";
import { TypeBuilder } from "./type-builder.js";
export { TypeBuilder, TypeBuilderBuildError } from "./type-builder.js";

const bin = binaryen as unknown as AugmentedBinaryen;

export const defineStructType = (
  mod: binaryen.Module,
  struct: Struct
): TypeRef => {
  const structIndex = 0;
  const builder = new TypeBuilder(1);
  try {
    builder.setStruct(structIndex, struct);
    if (struct.supertype) builder.setSubType(structIndex, struct.supertype);
    if (!struct.final) builder.setOpen(structIndex);
    const result = builder.build();
    annotateStructNames(mod, result, struct);
    return bin._BinaryenTypeFromHeapType(result, true); // Has to be nullable for now so initialize an array of ref types
  } finally {
    builder.dispose();
  }
};

export const defineArrayType = (
  mod: binaryen.Module,
  elementType: TypeRef,
  mutable = false,
  name?: string
): TypeRef => {
  const builder = new TypeBuilder(1);
  try {
    builder.setArrayType(
      0,
      elementType,
      bin._BinaryenPackedTypeNotPacked(),
      mutable
    );
    const result = builder.build();

    if (name) {
      bin._BinaryenModuleSetTypeName(
        mod.ptr,
        result,
        bin.stringToUTF8OnStack(name)
      );
    }

    return bin._BinaryenTypeFromHeapType(result, true); // Has to be nullable for now so initialize an array of ref types
  } finally {
    builder.dispose();
  }
};

export const binaryenTypeToHeapType = (type: Type): HeapTypeRef => {
  return bin._BinaryenTypeGetHeapType(type);
};

export const binaryenTypeFromHeapType = (
  type: HeapTypeRef,
  nullable = false
): HeapTypeRef => {
  return bin._BinaryenTypeFromHeapType(type, nullable);
};

// So we can use the from compileBnrCall
export const modBinaryenTypeToHeapType = (
  _mod: binaryen.Module,
  type: Type
): HeapTypeRef => {
  return bin._BinaryenTypeGetHeapType(type);
};

export const callRef = (
  module: binaryen.Module,
  target: ExpressionRef,
  operands: ExpressionRef[],
  returnType: TypeRef,
  isReturn = false
): ExpressionRef => {
  const operandsPtr = allocU32Array(operands);
  const result = bin._BinaryenCallRef(
    module.ptr,
    target,
    operandsPtr,
    operands.length,
    returnType,
    isReturn
  );

  bin._free(operandsPtr);
  return result;
};

export const refFunc = (
  mod: binaryen.Module,
  func: string,
  type: TypeRef
): ExpressionRef =>
  bin._BinaryenRefFunc(mod.ptr, bin.stringToUTF8OnStack(func), type);

export const refCast = (
  mod: binaryen.Module,
  ref: ExpressionRef,
  type: TypeRef
): ExpressionRef => bin._BinaryenRefCast(mod.ptr, ref, type);

export const refTest = (
  mod: binaryen.Module,
  ref: ExpressionRef,
  type: TypeRef
): ExpressionRef => bin._BinaryenRefTest(mod.ptr, ref, type);

export const initStruct = (
  mod: binaryen.Module,
  structType: TypeRef,
  values: ExpressionRef[]
): ExpressionRef => {
  const structNewArgs = allocU32Array(values);
  const structNew = bin._BinaryenStructNew(
    mod.ptr,
    structNewArgs,
    values.length,
    binaryenTypeToHeapType(structType)
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

export const structSetFieldValue = ({
  mod,
  fieldIndex,
  ref,
  value,
}: {
  mod: binaryen.Module;
  fieldIndex: number;
  ref: ExpressionRef;
  value: ExpressionRef;
}): ExpressionRef => {
  return bin._BinaryenStructSet(mod.ptr, fieldIndex, ref, value);
};

export const arrayGet = (
  mod: binaryen.Module,
  arrayRef: ExpressionRef,
  index: ExpressionRef,
  elementType: TypeRef,
  signed: boolean
): ExpressionRef => {
  return bin._BinaryenArrayGet(mod.ptr, arrayRef, index, elementType, signed);
};

export const arraySet = (
  mod: binaryen.Module,
  arrayRef: ExpressionRef,
  index: ExpressionRef,
  value: ExpressionRef
): ExpressionRef => {
  return bin._BinaryenArraySet(mod.ptr, arrayRef, index, value);
};

export const arrayLen = (
  mod: binaryen.Module,
  arrayRef: ExpressionRef
): ExpressionRef => {
  return bin._BinaryenArrayLen(mod.ptr, arrayRef);
};

export const arrayNew = (
  mod: binaryen.Module,
  type: HeapTypeRef,
  size: ExpressionRef,
  init: ExpressionRef
): ExpressionRef => {
  return bin._BinaryenArrayNew(mod.ptr, type, size, init);
};

export const arrayNewFixed = (
  mod: binaryen.Module,
  type: HeapTypeRef,
  values: ExpressionRef[]
): ExpressionRef => {
  const valuesPtr = allocU32Array(values);
  const result = bin._BinaryenArrayNewFixed(
    mod.ptr,
    type,
    valuesPtr,
    values.length
  );
  bin._free(valuesPtr);
  return result;
};

export const initFixedArray = (
  mod: binaryen.Module,
  type: TypeRef,
  values: ExpressionRef[]
): ExpressionRef => {
  return arrayNewFixed(mod, binaryenTypeToHeapType(type), values);
};

export const arrayCopy = (
  mod: binaryen.Module,
  destRef: ExpressionRef,
  destIndex: ExpressionRef,
  srcRef: ExpressionRef,
  srcIndex: ExpressionRef,
  length: ExpressionRef
): ExpressionRef => {
  return bin._BinaryenArrayCopy(
    mod.ptr,
    destRef,
    destIndex,
    srcRef,
    srcIndex,
    length
  );
};

/** Returns a pointer to the allocated array */
const allocU32Array = (u32s: number[]): number => {
  const ptr = bin._malloc(u32s.length << 2);
  if (bin.HEAPU32) {
    bin.HEAPU32.set(u32s, ptr >>> 2);
  } else {
    u32s.forEach((value, index) => {
      bin.__i32_store(ptr + (index << 2), value >>> 0);
    });
  }
  return ptr;
};

export const annotateStructNames = (
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
