import binaryen from "binaryen";
import {
  AugmentedBinaryen,
  ExpressionRef,
  HeapTypeRef,
  Struct,
  Type,
  TypeRef,
} from "./types.js";

const bin = binaryen as unknown as AugmentedBinaryen;

export const defineStructType = (
  mod: binaryen.Module,
  struct: Struct
): TypeRef => {
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
    fields.reduce((acc, { mutable }, index) => {
      // Calculate which u32 slot this boolean belongs to
      const u32Index = Math.floor(index / 4);

      // Ensure the slot exists and initialize it to 0 if it doesn't
      if (typeof acc[u32Index] === "undefined") {
        acc[u32Index] = 0;
      }

      // Pack the boolean into the appropriate position in the u32
      const shiftAmount = (index % 4) * 8;
      acc[u32Index] |= (mutable ? 1 : 0) << shiftAmount;

      return acc;
    }, [] as number[])
  );

  bin._TypeBuilderSetStructType(
    typeBuilder,
    structIndex,
    fieldTypesPtr,
    fieldPackedTypesPtr,
    fieldMutablesPtr,
    fields.length
  );

  if (struct.supertype) {
    bin._TypeBuilderSetSubType(typeBuilder, structIndex, struct.supertype);
  }

  if (!struct.final) bin._TypeBuilderSetOpen(typeBuilder, structIndex);

  bin._free(fieldTypesPtr);
  bin._free(fieldPackedTypesPtr);
  bin._free(fieldMutablesPtr);

  const result = typeBuilderBuildAndDispose(typeBuilder);

  annotateStructNames(mod, result, struct);

  return bin._BinaryenTypeFromHeapType(result, false);
};

export const defineArrayType = (
  mod: binaryen.Module,
  elementType: TypeRef,
  mutable = false,
  name?: string
): TypeRef => {
  const typeBuilder = bin._TypeBuilderCreate(1);
  bin._TypeBuilderSetArrayType(
    typeBuilder,
    0,
    elementType,
    bin._BinaryenPackedTypeNotPacked(),
    mutable
  );

  const result = typeBuilderBuildAndDispose(typeBuilder);

  if (name) {
    bin._BinaryenModuleSetTypeName(
      mod.ptr,
      result,
      bin.stringToUTF8OnStack(name)
    );
  }

  return bin._BinaryenTypeFromHeapType(result, false);
};

const typeBuilderBuildAndDispose = (typeBuilder: number): HeapTypeRef => {
  const size = bin._TypeBuilderGetSize(typeBuilder);
  const out = bin._malloc(Math.max(4 * size, 8));

  if (!bin._TypeBuilderBuildAndDispose(typeBuilder, out, out, out + 4)) {
    bin._free(out);
    throw new Error("_TypeBuilderBuildAndDispose failed");
  }

  const result = bin.__i32_load(out);
  bin._free(out);

  return result;
};

export const binaryenTypeToHeapType = (type: Type): HeapTypeRef => {
  return bin._BinaryenTypeGetHeapType(type);
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
