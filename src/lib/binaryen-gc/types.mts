import binaryen from "binaryen";

type usize = number;
type bool = boolean;
type u32 = number;
type i32 = number;

export type Type = usize;
export type Ref = usize;
export type ModuleRef = Ref;
export type TypeRef = Ref;
export type HeapTypeRef = Ref;
export type Index = u32;
export type PackedType = u32;
export type TypeBuilderRef = Ref;
export type TypeBuilderErrorReason = u32;
export type ArrayRef<_T> = Ref;
export type Pointer<_T> = Ref;
export type ExpressionRef = number;
export type Module = binaryen.Module;

export type Struct = {
  name: string;
  fields: StructField[];
};

export type StructField = {
  type: TypeRef;
  name: string;
  /** Defaults to unpacked */
  packedType?: PackedType;
  /** Defaults to immutable */
  mutable?: bool;
};

export type AugmentedBinaryen = typeof binaryen & {
  _BinaryenTypeFromHeapType(heapType: HeapTypeRef, nullable: bool): TypeRef;
  _BinaryenPackedTypeNotPacked(): PackedType;
  _BinaryenTypeGetHeapType(type: TypeRef): HeapTypeRef;
  _BinaryenArrayTypeGetElementType(heapType: HeapTypeRef): TypeRef;
  _BinaryenStructTypeGetNumFields(heapType: HeapTypeRef): Index;
  _BinaryenStructTypeGetFieldType(heapType: HeapTypeRef, index: Index): TypeRef;
  _TypeBuilderCreate(size: Index): TypeBuilderRef;
  _TypeBuilderSetArrayType(
    builder: TypeBuilderRef,
    index: Index,
    elementType: TypeRef,
    elementPackedTyype: PackedType,
    elementMutable: bool
  ): void;
  _malloc(size: usize): usize;
  _free(ptr: usize): void;
  __i32_load(ptr: usize): number;
  __i32_store(ptr: usize, value: number): void;
  __i32_store8(ptr: usize, value: number): void;
  _TypeBuilderSetStructType(
    builder: TypeBuilderRef,
    index: Index,
    fieldTypes: ArrayRef<TypeRef>,
    fieldPackedTypes: ArrayRef<PackedType>,
    fieldMutables: ArrayRef<bool>,
    numFields: i32
  ): void;
  _BinaryenStructNew(
    module: ModuleRef,
    operands: ArrayRef<ExpressionRef>,
    numOperands: Index,
    type: HeapTypeRef
  ): ExpressionRef;
  _BinaryenStructGet(
    module: ModuleRef,
    index: Index,
    ref: ExpressionRef,
    type: TypeRef,
    signed: bool
  ): ExpressionRef;
  _BinaryenStructSet(
    module: ModuleRef,
    index: Index,
    ref: ExpressionRef,
    value: ExpressionRef
  ): ExpressionRef;
  _TypeBuilderGetTempHeapType(
    builder: TypeBuilderRef,
    index: Index
  ): HeapTypeRef;
  _TypeBuilderGetSize(builder: TypeBuilderRef): Index;
  _TypeBuilderBuildAndDispose(
    builder: TypeBuilderRef,
    heapTypes: ArrayRef<HeapTypeRef>,
    errorIndex: Pointer<Index>,
    errorReason: Pointer<TypeBuilderErrorReason>
  ): bool;
  allocateUTF8OnStack: (s: string) => number;
  _BinaryenArrayNew(
    module: ModuleRef,
    type: HeapTypeRef,
    size: ExpressionRef,
    init: ExpressionRef
  ): ExpressionRef;
  _BinaryenArrayNewData(
    module: ModuleRef,
    heapType: HeapTypeRef,
    name: number,
    offset: ExpressionRef,
    size: ExpressionRef
  ): ExpressionRef;
  _BinaryenArrayNewFixed(
    module: ModuleRef,
    type: HeapTypeRef,
    values: ArrayRef<ExpressionRef>,
    numValues: Index
  ): ExpressionRef;
  _BinaryenArrayCopy(
    module: ModuleRef,
    destRef: ExpressionRef,
    destIndex: ExpressionRef,
    srcRef: ExpressionRef,
    srcIndex: ExpressionRef,
    length: ExpressionRef
  ): ExpressionRef;
  _BinaryenArrayGet(
    module: ModuleRef,
    ref: ExpressionRef,
    index: ExpressionRef,
    type: TypeRef,
    signed: bool
  ): ExpressionRef;
  _BinaryenArraySet(
    module: ModuleRef,
    ref: ExpressionRef,
    index: ExpressionRef,
    value: ExpressionRef
  ): ExpressionRef;
  _BinaryenArrayLen(module: ModuleRef, ref: ExpressionRef): ExpressionRef;
  _BinaryenArrayGetPtr(
    module: ModuleRef,
    ref: ExpressionRef,
    index: ExpressionRef
  ): ExpressionRef;
  _BinaryenArraySetPtr(
    module: ModuleRef,
    ref: ExpressionRef,
    index: ExpressionRef,
    value: ExpressionRef
  ): ExpressionRef;
  _BinaryenArrayToStack(module: ModuleRef, ref: ExpressionRef): ExpressionRef;
  _BinaryenArrayFromStack(module: ModuleRef, ref: ExpressionRef): ExpressionRef;
  _BinaryenModuleSetTypeName(
    module: ModuleRef,
    type: HeapTypeRef,
    name: unknown
  ): void;
  _BinaryenModuleSetFieldName(
    module: ModuleRef,
    type: HeapTypeRef,
    index: number,
    name: unknown
  ): void;
  stringToUTF8OnStack(str: string): number;
};
