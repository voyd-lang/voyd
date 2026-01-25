import { binaryenTypeToHeapType, defineArrayType } from "@voyd/lib/binaryen-gc/index.js";
import type { CodegenContext, FixedArrayWasmType, TypeId } from "./context.js";

type WasmTypeMode = "runtime" | "signature";

export const ensureFixedArrayWasmTypesByElement = ({
  elementType,
  ctx,
}: {
  elementType: number;
  ctx: CodegenContext;
}): FixedArrayWasmType => {
  const cached = ctx.fixedArrayTypes.get(elementType);
  if (cached) {
    return cached;
  }
  const type = defineArrayType(ctx.mod, elementType, true);
  const heapType = binaryenTypeToHeapType(type);
  const fixedArrayType: FixedArrayWasmType = { type, heapType };
  ctx.fixedArrayTypes.set(elementType, fixedArrayType);
  return fixedArrayType;
};

export const ensureFixedArrayWasmTypes = ({
  typeId,
  ctx,
  seen,
  mode,
  lowerType,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
  seen: Set<TypeId>;
  mode: WasmTypeMode;
  lowerType: (
    typeId: TypeId,
    ctx: CodegenContext,
    seen: Set<TypeId>,
    mode: WasmTypeMode
  ) => number;
}): FixedArrayWasmType => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind !== "fixed-array") {
    throw new Error("intrinsic requires a fixed-array type");
  }
  // Arrays are invariant, so signatures must use a concrete array heap type.
  // Use the caller-provided mode to avoid forcing RTT emission during signature lowering.
  const elementType = lowerType(desc.element, ctx, seen, mode);
  return ensureFixedArrayWasmTypesByElement({ elementType, ctx });
};
