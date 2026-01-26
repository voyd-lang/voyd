import binaryen from "binaryen";
import {
  AugmentedBinaryen,
  HeapTypeRef,
  Struct,
  TypeRef,
  PackedType,
} from "./types.js";

const bin = binaryen as unknown as AugmentedBinaryen;

export class TypeBuilderBuildError extends Error {
  errorIndex: number;
  errorReason: number;

  constructor({
    errorIndex,
    errorReason,
  }: {
    errorIndex: number;
    errorReason: number;
  }) {
    super(
      `_TypeBuilderBuildAndDispose failed: index ${errorIndex}, reason ${errorReason}`,
    );
    this.errorIndex = errorIndex;
    this.errorReason = errorReason;
  }
}

export class TypeBuilder {
  private builder: number;
  private allocations: number[] = [];
  private disposed = false;

  constructor(size: number) {
    this.builder = bin._TypeBuilderCreate(size);
    if (size > 1) {
      bin._TypeBuilderCreateRecGroup(this.builder, 0, size);
    }
  }

  getTempRefType(index: number, nullable = true): TypeRef {
    const heap = bin._TypeBuilderGetTempHeapType(this.builder, index);
    return bin._TypeBuilderGetTempRefType(this.builder, heap, nullable);
  }

  setStruct(index: number, struct: Struct): void {
    const fields = struct.fields;
    const fieldTypesPtr = this.allocU32Array(fields.map(({ type }) => type));
    const fieldPackedTypesPtr = this.allocU32Array(
      fields.map(
        ({ packedType }) => packedType ?? bin._BinaryenPackedTypeNotPacked()
      )
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

  buildAll(): HeapTypeRef[] {
    const size = bin._TypeBuilderGetSize(this.builder);
    // The underlying binaryen routine expects three separate pointers:
    // 1. an array of resulting heap types (`size` * 4 bytes)
    // 2. an index to store an error location (4 bytes)
    // 3. a reason code (4 bytes)
    // Allocate separate regions and wire them up correctly.
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
        const errorIndex = bin.__i32_load(errorIndexPtr);
        const errorReason = bin.__i32_load(errorReasonPtr);
        throw new TypeBuilderBuildError({ errorIndex, errorReason });
      }
      return Array.from({ length: size }, (_, i) => {
        return bin.HEAPU32[(heapTypesPtr >>> 2) + i]!;
      });
    } finally {
      bin._free(out);
      this.dispose();
    }
  }

  build(): HeapTypeRef {
    const [first] = this.buildAll();
    if (typeof first !== "number") {
      throw new Error("TypeBuilder.build() expected at least one heap type");
    }
    return first;
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
