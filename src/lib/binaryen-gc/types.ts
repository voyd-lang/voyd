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
  supertype?: HeapTypeRef;
  /** Set to true if the struct cannot be extended */
  final?: boolean;
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
  _BinaryenRefCast(
    module: ModuleRef,
    ref: ExpressionRef,
    type: TypeRef
  ): ExpressionRef;
  _BinaryenRefFunc(
    module: ModuleRef,
    funcName: number,
    type: TypeRef
  ): ExpressionRef;
  _BinaryenCallRef(
    module: ModuleRef,
    target: ExpressionRef,
    operands: ArrayRef<ExpressionRef>,
    numOperands: Index,
    type: TypeRef,
    isReturn: bool
  ): ExpressionRef;
  _BinaryenFunctionGetType(func: binaryen.FunctionRef): HeapTypeRef;
  _BinaryenHeapTypeIsSignature(heapType: HeapTypeRef): bool;
  _BinaryenTypeGetHeapType(type: TypeRef): HeapTypeRef;
  _BinaryenArrayTypeGetElementType(heapType: HeapTypeRef): TypeRef;
  _BinaryenStructTypeGetNumFields(heapType: HeapTypeRef): Index;
  _BinaryenStructTypeGetFieldType(heapType: HeapTypeRef, index: Index): TypeRef;
  _TypeBuilderCreate(size: Index): TypeBuilderRef;
  _TypeBuilderSetArrayType(
    builder: TypeBuilderRef,
    index: Index,
    elementType: TypeRef,
    elementPackedType: PackedType,
    elementMutable: bool
  ): void;
  _TypeBuilderSetSubType(
    builder: TypeBuilderRef,
    index: Index,
    supertype: HeapTypeRef
  ): void;
  _TypeBuilderSetStructType(
    builder: TypeBuilderRef,
    index: Index,
    fieldTypes: ArrayRef<TypeRef>,
    fieldPackedTypes: ArrayRef<PackedType>,
    fieldMutables: ArrayRef<bool>,
    numFields: i32
  ): void;
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
  _TypeBuilderSetOpen(builder: TypeBuilderRef, index: Index): void;
  _malloc(size: usize): usize;
  _free(ptr: usize): void;
  __i32_load(ptr: usize): number;
  __i32_store(ptr: usize, value: number): void;
  __i32_store8(ptr: usize, value: number): void;
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
  _BinaryenRefTest(
    module: ModuleRef,
    ref: ExpressionRef,
    type: TypeRef
  ): ExpressionRef;
  stringToUTF8OnStack(str: string): number;
  HEAPU32: Uint32Array;
};
