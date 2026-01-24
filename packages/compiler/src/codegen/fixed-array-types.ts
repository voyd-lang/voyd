import { binaryenTypeToHeapType, defineArrayType } from "@voyd/lib/binaryen-gc/index.js";
import type { CodegenContext, FixedArrayWasmType, TypeId } from "./context.js";

type WasmTypeMode = "runtime" | "signature";

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
  const cached = ctx.fixedArrayTypes.get(desc.element);
  if (cached) {
    return cached;
  }
  const elementType = lowerType(desc.element, ctx, seen, mode);
  const type = defineArrayType(ctx.mod, elementType, true);
  const heapType = binaryenTypeToHeapType(type);
  const fixedArrayType: FixedArrayWasmType = { type, heapType };
  ctx.fixedArrayTypes.set(desc.element, fixedArrayType);
  return fixedArrayType;
};
