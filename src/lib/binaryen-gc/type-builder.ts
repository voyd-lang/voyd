import binaryen from "binaryen";
import {
  AugmentedBinaryen,
  HeapTypeRef,
  Struct,
  TypeRef,
  PackedType,
} from "./types.js";

const bin = binaryen as unknown as AugmentedBinaryen;

export class TypeBuilder {
  private builder: number;
  private allocations: number[] = [];
  private disposed = false;

  constructor(size: number) {
    this.builder = bin._TypeBuilderCreate(size);
  }

  getTempRefType(index: number, nullable = true): TypeRef {
    const heap = bin._TypeBuilderGetTempHeapType(this.builder, index);
    return bin._TypeBuilderGetTempRefType(this.builder, heap, nullable);
  }

  setStruct(index: number, struct: Struct): void {
    const fields = struct.fields;
    const fieldTypesPtr = this.allocU32Array(fields.map(({ type }) => type));
    const fieldPackedTypesPtr = this.allocU32Array(
      fields.map(({ packedType }) => packedType ?? bin._BinaryenPackedTypeNotPacked())
    );
    const fieldMutablesPtr = this.allocU32Array(
      fields.reduce((acc, { mutable }, i) => {
        const u32Index = Math.floor(i / 4);
        if (typeof acc[u32Index] === "undefined") acc[u32Index] = 0;
        const shiftAmount = (i % 4) * 8;
        acc[u32Index] |= (mutable ? 1 : 0) << shiftAmount;
        return acc;
      }, [] as number[])
    );

    bin._TypeBuilderSetStructType(
      this.builder,
      index,
      fieldTypesPtr,
      fieldPackedTypesPtr,
      fieldMutablesPtr,
      fields.length
    );
  }

  setArrayType(
    index: number,
    elementType: TypeRef,
    elementPackedType: PackedType,
    elementMutable: boolean
  ): void {
    bin._TypeBuilderSetArrayType(
      this.builder,
      index,
      elementType,
      elementPackedType,
      elementMutable
    );
  }

  setSubType(index: number, supertype: HeapTypeRef): void {
    bin._TypeBuilderSetSubType(this.builder, index, supertype);
  }

  setOpen(index: number): void {
    bin._TypeBuilderSetOpen(this.builder, index);
  }

  build(): HeapTypeRef {
    const size = bin._TypeBuilderGetSize(this.builder);
    // The underlying binaryen routine expects three separate pointers:
    // 1. an array of resulting heap types (`size` * 4 bytes)
    // 2. an index to store an error location (4 bytes)
    // 3. a reason code (4 bytes)
    //
    // The previous implementation reused the same pointer for all three
    // locations which meant the builder wrote the error information over the
    // heap type results. This corrupted memory and caused
    // `_TypeBuilderBuildAndDispose` to fail when building more complex GC
    // types such as closures. Allocate separate regions and wire them up
    // correctly.
    const out = bin._malloc(4 * size + 8);
    const heapTypesPtr = out;
    const errorIndexPtr = out + 4 * size;
    const errorReasonPtr = errorIndexPtr + 4;

    try {
      if (
        !bin._TypeBuilderBuildAndDispose(
          this.builder,
          heapTypesPtr,
          errorIndexPtr,
          errorReasonPtr
        )
      ) {
        // Provide some additional context when a build fails so debugging is
        // easier in tests.
        const errorIndex = bin.__i32_load(errorIndexPtr);
        const errorReason = bin.__i32_load(errorReasonPtr);
        throw new Error(
          `_TypeBuilderBuildAndDispose failed: index ${errorIndex}, reason ${errorReason}`
        );
      }
      const result = bin.__i32_load(heapTypesPtr);
      return result;
    } finally {
      bin._free(out);
      this.dispose();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    for (const ptr of this.allocations) {
      bin._free(ptr);
    }
    this.allocations.length = 0;
    this.disposed = true;
  }

  private allocU32Array(u32s: number[]): number {
    const ptr = bin._malloc(u32s.length << 2);
    bin.HEAPU32.set(u32s, ptr >>> 2);
    this.allocations.push(ptr);
    return ptr;
  }
}
