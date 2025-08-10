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
    const out = bin._malloc(Math.max(4 * size, 8));
    try {
      if (!bin._TypeBuilderBuildAndDispose(this.builder, out, out, out + 4)) {
        throw new Error("_TypeBuilderBuildAndDispose failed");
      }
      const result = bin.__i32_load(out);
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
