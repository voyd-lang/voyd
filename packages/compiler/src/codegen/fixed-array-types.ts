import binaryen from "binaryen";
import {
  binaryenTypeToHeapType,
  defineArrayType,
  defineStructType,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import type { CodegenContext, FixedArrayWasmType, TypeId } from "./context.js";

type WasmTypeMode = "runtime" | "signature";

const FIXED_ARRAY_TYPE_STATE = Symbol.for("voyd.codegen.fixedArrayTypesByTypeId");

type FixedArrayTypeState = {
  byTypeId?: Map<TypeId, FixedArrayWasmType>;
  inlineByKey?: Map<string, FixedArrayWasmType>;
};

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_]/g, "_");

export const ensureFixedArrayWasmTypesByElement = ({
  elementType,
  ctx,
}: {
  elementType: number;
  ctx: CodegenContext;
}): FixedArrayWasmType => {
  if (binaryen.expandType(elementType).length > 1) {
    throw new Error(`fixed-array element lowered to multivalue type ${elementType}`);
  }
  const cached = ctx.fixedArrayTypes.get(elementType);
  if (cached) {
    return cached;
  }
  const type = defineArrayType(ctx.mod, elementType, true);
  const heapType = binaryenTypeToHeapType(type);
  const fixedArrayType: FixedArrayWasmType = {
    kind: "plain-array",
    type,
    heapType,
  };
  ctx.fixedArrayTypes.set(elementType, fixedArrayType);
  return fixedArrayType;
};

export const ensureInlineFixedArrayWasmTypes = ({
  key,
  laneTypes,
  ctx,
}: {
  key: string;
  laneTypes: readonly binaryen.Type[];
  ctx: CodegenContext;
}): FixedArrayWasmType => {
  const state = ctx.programHelpers.getHelperState<FixedArrayTypeState>(
    FIXED_ARRAY_TYPE_STATE,
    () => ({ byTypeId: new Map<TypeId, FixedArrayWasmType>(), inlineByKey: new Map() }),
  );
  const inlineByKey = state.inlineByKey ?? new Map<string, FixedArrayWasmType>();
  state.inlineByKey = inlineByKey;
  const cached = inlineByKey.get(key);
  if (cached) {
    return cached;
  }

  const laneArrayTypes = laneTypes.map((laneType) =>
    ensureFixedArrayWasmTypesByElement({ elementType: laneType, ctx }).type,
  );
  const type = defineStructType(ctx.mod, {
    name: `voydInlineFixedArray_${sanitize(key)}`,
    fields: [
      { name: "length", type: binaryen.i32, mutable: false },
      ...laneArrayTypes.map((laneArrayType, index) => ({
        name: `lane_${index}`,
        type: laneArrayType,
        mutable: false,
      })),
    ],
    supertype: binaryenTypeToHeapType(ctx.rtt.rootType),
    final: true,
  });
  const fixedArrayType: FixedArrayWasmType = {
    kind: "inline-aggregate",
    type,
    heapType: binaryenTypeToHeapType(type),
    laneTypes,
    laneArrayTypes,
  };
  inlineByKey.set(key, fixedArrayType);
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
  const state = ctx.programHelpers.getHelperState<FixedArrayTypeState>(
    FIXED_ARRAY_TYPE_STATE,
    () => ({ byTypeId: new Map<TypeId, FixedArrayWasmType>() }),
  );
  const byTypeId = state.byTypeId ?? new Map<TypeId, FixedArrayWasmType>();
  state.byTypeId = byTypeId;
  const cachedByTypeId = byTypeId.get(typeId);
  if (cachedByTypeId) {
    return cachedByTypeId;
  }

  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind !== "fixed-array") {
    throw new Error("intrinsic requires a fixed-array type");
  }
  // Wasm GC arrays are invariant, so any `FixedArray<T>` used in a signature must
  // lower to the *same* concrete array heap type as runtime values. In practice,
  // this means the element type lowering must stay concrete for structural/nominal
  // types even when the caller is lowering in signature mode.
  const elementType = lowerType(desc.element, ctx, seen, mode);
  const wasmTypes = ensureFixedArrayWasmTypesByElement({ elementType, ctx });
  byTypeId.set(typeId, wasmTypes);
  return wasmTypes;
};
