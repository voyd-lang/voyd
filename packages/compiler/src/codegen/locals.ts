import binaryen from "binaryen";
import type {
  CodegenContext,
  FunctionContext,
  LocalBinding,
  LocalBindingProjectedElement,
  LocalBindingProjectedField,
  LocalBindingLocal,
  LocalBindingStorageRef,
  StructuralFieldInfo,
  StructuralTypeInfo,
  SymbolId,
  TypeId,
} from "./context.js";
import {
  arrayGet,
  arraySet,
  refCast,
  structGetFieldValue,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import {
  coerceValueToType,
  fixedArrayStorageElementType,
  initStructuralValue,
  liftFixedArrayElementValue,
  liftHeapValueToInline,
  lowerValueForHeapField,
  loadStructuralField,
  storeStructuralField,
  storeValueIntoStorageRef,
} from "./structural.js";
import {
  getInlineHeapBoxType,
  getMutableRefStorageType,
  getStructuralTypeInfo,
  getSymbolTypeId,
  wasmTypeFor,
} from "./types.js";
import { coerceExprToWasmType } from "./wasm-type-coercions.js";
import { captureMultivalueLanes } from "./multivalue.js";
import {
  boxSignatureSpillValue,
  isSignatureSpillStorage,
  signatureSpillStorageType,
  unboxSignatureSpillValue,
} from "./signature-spill.js";

export const declareLocalWithTypeId = (
  symbol: SymbolId,
  typeId: number,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): LocalBinding => {
  const existing = fnCtx.bindings.get(symbol);
  if (existing) {
    return existing;
  }

  const binding = allocateAddressableLocal({
    typeId,
    ctx,
    fnCtx,
  });
  fnCtx.bindings.set(symbol, { ...binding, kind: "local", typeId });
  return binding;
};

export const declareMutableLocalWithTypeId = (
  symbol: SymbolId,
  typeId: number,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
): LocalBinding => {
  const existing = fnCtx.bindings.get(symbol);
  if (existing) {
    return existing;
  }
  const binding = allocateMutableRefLocal({ typeId, ctx, fnCtx });
  fnCtx.bindings.set(symbol, { ...binding, kind: "local", typeId });
  return binding;
};

export const declareLocal = (
  symbol: SymbolId,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): LocalBinding => {
  const existing = fnCtx.bindings.get(symbol);
  if (existing) {
    return existing;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const typeId = getSymbolTypeId(symbol, ctx, typeInstanceId);
  const binding = allocateAddressableLocal({
    typeId,
    ctx,
    fnCtx,
  });
  fnCtx.bindings.set(symbol, { ...binding, kind: "local", typeId });
  return binding;
};

export const getRequiredBinding = (
  symbol: SymbolId,
  ctx: CodegenContext,
  fnCtx: FunctionContext
): LocalBinding => {
  const binding = fnCtx.bindings.get(symbol);
  if (!binding) {
    const name =
      ctx.program.symbols.getName(
        ctx.program.symbols.idOf({ moduleId: ctx.moduleId, symbol })
      ) ?? `${symbol}`;
    throw new Error(
      `codegen missing binding for symbol ${name}`
    );
  }
  return binding;
};

export const allocateTempLocal = (
  type: binaryen.Type,
  fnCtx: FunctionContext,
  typeId?: number,
  ctx?: CodegenContext
): LocalBindingLocal => {
  const storageType =
    typeof typeId === "number" && ctx && binaryen.expandType(type).length > 1
      ? getInlineHeapBoxType({ typeId, ctx }) ??
        signatureSpillStorageType({
          typeId,
          ctx,
        })
      : type;
  const binding: LocalBindingLocal = {
    kind: "local",
    index: fnCtx.nextLocalIndex,
    type,
    storageType,
    typeId,
  };
  fnCtx.nextLocalIndex += 1;
  fnCtx.locals.push(storageType);
  return binding;
};

export const allocateAddressableLocal = ({
  typeId,
  ctx,
  fnCtx,
}: {
  typeId: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): LocalBindingLocal => {
  const type = wasmTypeFor(typeId, ctx);
  const inlineBoxType = getInlineHeapBoxType({ typeId, ctx });
  const allocated = allocateTempLocal(type, fnCtx, typeId, ctx);
  if (typeof inlineBoxType !== "number" || allocated.storageType !== type) {
    return allocated;
  }
  fnCtx.locals[fnCtx.locals.length - 1] = inlineBoxType;
  return {
    ...allocated,
    storageType: inlineBoxType,
  };
};

export const allocateMutableRefLocal = ({
  typeId,
  ctx,
  fnCtx,
}: {
  typeId: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): LocalBindingLocal => {
  const type = wasmTypeFor(typeId, ctx);
  const storageType = getMutableRefStorageType({ typeId, ctx });
  if (typeof storageType !== "number") {
    throw new Error(`mutable ref local requires addressable storage for ${typeId}`);
  }
  const allocated = allocateTempLocal(type, fnCtx, typeId, ctx);
  if (allocated.storageType === storageType) {
    return allocated;
  }
  fnCtx.locals[fnCtx.locals.length - 1] = storageType;
  return {
    ...allocated,
    storageType,
  };
};

export const createStorageRefBinding = ({
  index,
  typeId,
  mutable,
  ctx,
}: {
  index: number;
  typeId: number;
  mutable: boolean;
  ctx: CodegenContext;
}): LocalBindingStorageRef => {
  const storageType = mutable
    ? getMutableRefStorageType({ typeId, ctx })
    : getInlineHeapBoxType({ typeId, ctx });
  if (typeof storageType !== "number") {
    throw new Error(`storage ref binding requires boxed inline storage for ${typeId}`);
  }
  return {
    kind: "storage-ref",
    index,
    mutable,
    type: wasmTypeFor(typeId, ctx),
    storageType,
    typeId,
  };
};

export const loadLocalValue = (
  binding: LocalBindingLocal,
  ctx: CodegenContext
): binaryen.ExpressionRef => {
  const stored = ctx.mod.local.get(binding.index, binding.storageType);
  if (
    binding.storageType === binding.type ||
    typeof binding.typeId !== "number"
  ) {
    return stored;
  }
  if (isSignatureSpillStorage({
    typeId: binding.typeId,
    storageType: binding.storageType,
    ctx,
  })) {
    return unboxSignatureSpillValue({
      value: stored,
      typeId: binding.typeId,
      ctx,
    });
  }
  return liftHeapValueToInline({
    value: stored,
    typeId: binding.typeId,
    ctx,
  });
};

export const storeLocalValue = ({
  binding,
  value,
  ctx,
  fnCtx,
}: {
  binding: LocalBindingLocal;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  if (binaryen.expandType(binding.storageType).length > 1) {
    const abiTypes = [...binaryen.expandType(binding.storageType)];
    const captured = captureMultivalueLanes({
      value: coerceExprToWasmType({
        expr: value,
        targetType: binding.storageType,
        ctx,
      }),
      abiTypes,
      ctx,
      fnCtx,
    });
    const stabilized = ctx.mod.tuple.make(captured.lanes as binaryen.ExpressionRef[]);
    return captured.setup.length === 0
      ? ctx.mod.local.set(binding.index, stabilized)
      : ctx.mod.block(
          null,
          [...captured.setup, ctx.mod.local.set(binding.index, stabilized)],
          binaryen.none,
        );
  }
  if (
    binding.storageType === binding.type ||
    typeof binding.typeId !== "number"
  ) {
    return ctx.mod.local.set(
      binding.index,
      coerceExprToWasmType({
        expr: value,
        targetType: binding.storageType,
        ctx,
      }),
    );
  }
  if (isSignatureSpillStorage({
    typeId: binding.typeId,
    storageType: binding.storageType,
    ctx,
  })) {
    return ctx.mod.local.set(
      binding.index,
      boxSignatureSpillValue({
        value,
        typeId: binding.typeId,
        ctx,
        fnCtx,
      }),
    );
  }
  const stored = lowerValueForHeapField({
    value,
    typeId: binding.typeId,
    targetType: binding.storageType,
    ctx,
    fnCtx,
  });
  return ctx.mod.local.set(binding.index, stored);
};

export const loadBindingValue = (
  binding: LocalBinding,
  ctx: CodegenContext,
  fnCtx?: FunctionContext,
): binaryen.ExpressionRef => {
  if (binding.kind === "storage-ref") {
    return liftHeapValueToInline({
      value: ctx.mod.local.get(binding.index, binding.storageType),
      typeId: binding.typeId!,
      ctx,
    });
  }
  if (binding.kind === "scalar-aggregate") {
    return loadScalarAggregateBindingValue({ binding, ctx, fnCtx });
  }
  if (binding.kind === "projected-element-ref") {
    return loadProjectedElementBindingValue(binding, ctx, fnCtx);
  }
  if (binding.kind === "projected-field-ref") {
    if (!fnCtx) {
      throw new Error("projected field loads require a function context");
    }
    return loadProjectedFieldBindingValue(binding, ctx, fnCtx);
  }
  if (binding.kind === "local") {
    return loadLocalValue(binding, ctx);
  }
  const envRef = ctx.mod.local.get(binding.envIndex, binding.envSuperType);
  const typedEnv =
    binding.envType === binding.envSuperType
      ? envRef
      : refCast(ctx.mod, envRef, binding.envType);
  const stored = structGetFieldValue({
    mod: ctx.mod,
    fieldIndex: binding.fieldIndex,
    fieldType: binding.storageType,
    exprRef: typedEnv,
  });
  if (
    binding.storageType === binding.type ||
    typeof binding.typeId !== "number"
  ) {
    return stored;
  }
  if (isSignatureSpillStorage({
    typeId: binding.typeId,
    storageType: binding.storageType,
    ctx,
  })) {
    return unboxSignatureSpillValue({
      value: stored,
      typeId: binding.typeId,
      ctx,
    });
  }
  return liftHeapValueToInline({
    value: stored,
    typeId: binding.typeId,
    ctx,
  });
};

export const loadBindingStorageRef = (
  binding: LocalBinding,
  ctx: CodegenContext,
): binaryen.ExpressionRef | undefined => {
  if (binding.kind === "storage-ref") {
    return ctx.mod.local.get(binding.index, binding.storageType);
  }
  if (binding.kind === "scalar-aggregate") {
    return undefined;
  }
  if (binding.kind === "projected-element-ref") {
    return loadProjectedElementBindingStorageRef(binding, ctx);
  }
  if (binding.kind === "projected-field-ref") {
    return undefined;
  }
  if (binding.kind === "local") {
    if (
      typeof binding.typeId !== "number" ||
      binding.storageType !==
        getMutableRefStorageType({ typeId: binding.typeId, ctx })
    ) {
      return undefined;
    }
    return ctx.mod.local.get(binding.index, binding.storageType);
  }
  if (
    typeof binding.typeId !== "number" ||
    binding.storageType !==
      getMutableRefStorageType({ typeId: binding.typeId, ctx })
  ) {
    return undefined;
  }
  const envRef = ctx.mod.local.get(binding.envIndex, binding.envSuperType);
  const typedEnv =
    binding.envType === binding.envSuperType
      ? envRef
      : refCast(ctx.mod, envRef, binding.envType);
  return structGetFieldValue({
    mod: ctx.mod,
    fieldIndex: binding.fieldIndex,
    fieldType: binding.storageType,
    exprRef: typedEnv,
  });
};

export const materializeOwnedBinding = ({
  symbol,
  ctx,
  fnCtx,
}: {
  symbol: SymbolId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): {
  binding: LocalBindingLocal;
  setup: readonly binaryen.ExpressionRef[];
} => {
  const existing = getRequiredBinding(symbol, ctx, fnCtx);
  if (existing.kind === "local") {
    return { binding: existing, setup: [] };
  }
  if (existing.kind === "scalar-aggregate") {
    const owned =
      typeof existing.typeId === "number" &&
      typeof getInlineHeapBoxType({ typeId: existing.typeId, ctx }) === "number"
        ? allocateAddressableLocal({
            typeId: existing.typeId,
            ctx,
            fnCtx,
          })
        : allocateTempLocal(existing.type, fnCtx, existing.typeId, ctx);
    const setup = [
      storeLocalValue({
        binding: owned,
        value: loadBindingValue(existing, ctx, fnCtx),
        ctx,
        fnCtx,
      }),
    ];
    fnCtx.bindings.set(symbol, {
      ...owned,
      kind: "local",
      typeId: existing.typeId,
    });
    return { binding: owned, setup };
  }
  if (existing.kind === "capture") {
    throw new Error("cannot materialize capture binding into owned local storage");
  }
  const typeId = existing.typeId;
  if (typeof typeId !== "number") {
    throw new Error(`cannot materialize symbol ${symbol} without a concrete type`);
  }
  const owned = allocateTempLocal(existing.type, fnCtx, typeId, ctx);
  const setup = [
    storeLocalValue({
      binding: owned,
      value: loadBindingValue(existing, ctx, fnCtx),
      ctx,
      fnCtx,
    }),
  ];
  fnCtx.bindings.set(symbol, {
    ...owned,
    kind: "local",
    typeId,
  });
  return { binding: owned, setup };
};

export const loadProjectedElementBindingStorageRef = (
  _binding: LocalBindingProjectedElement,
  _ctx: CodegenContext,
): binaryen.ExpressionRef | undefined => {
  return undefined;
};

export const loadProjectedElementBindingValue = (
  binding: LocalBindingProjectedElement,
  ctx: CodegenContext,
  fnCtx?: FunctionContext,
): binaryen.ExpressionRef => {
  const arrayRef = () =>
    ctx.mod.local.get(binding.arrayIndex, wasmTypeFor(binding.arrayTypeId, ctx));
  const indexRef = () => ctx.mod.local.get(binding.indexIndex, binaryen.i32);
  const loaded = arrayGet(
    ctx.mod,
    arrayRef(),
    indexRef(),
    fixedArrayStorageElementType({ typeId: binding.typeId!, ctx }),
    false,
  );
  if (fnCtx) {
    return liftFixedArrayElementValue({
      value: loaded,
      typeId: binding.typeId!,
      ctx,
      fnCtx,
    });
  }
  return liftHeapValueToInline({
    value: loaded,
    typeId: binding.typeId!,
    ctx,
  });
};

export const storeProjectedElementBindingValue = ({
  binding,
  value,
  ctx,
  fnCtx,
}: {
  binding: LocalBindingProjectedElement;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef =>
  arraySet(
    ctx.mod,
    ctx.mod.local.get(
      binding.arrayIndex,
      wasmTypeFor(binding.arrayTypeId, ctx),
    ),
    ctx.mod.local.get(binding.indexIndex, binaryen.i32),
    lowerValueForHeapField({
      value,
      typeId: binding.typeId!,
      targetType: fixedArrayStorageElementType({
        typeId: binding.typeId!,
        ctx,
      }),
      ctx,
      fnCtx,
    }),
  );

const loadProjectedFieldBindingValue = (
  binding: LocalBindingProjectedField,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
): binaryen.ExpressionRef => {
  const { segments } = projectedFieldSegments(binding, ctx);
  const rootTemp = allocateTempLocal(
    wasmTypeFor(binding.rootTypeId, ctx),
    fnCtx,
    binding.rootTypeId,
    ctx,
  );
  const ops = [
    storeLocalValue({
      binding: rootTemp,
      value: loadBindingValue(binding.root, ctx, fnCtx),
      ctx,
      fnCtx,
    }),
  ];
  let ownerTemp = rootTemp;
  segments.forEach((segment, index) => {
    const loaded = loadStructuralField({
      structInfo: segment.ownerInfo,
      field: segment.field,
      pointer: () => loadLocalValue(ownerTemp, ctx),
      ctx,
    });
    if (index === segments.length - 1) {
      ops.push(loaded);
      return;
    }
    const childTemp = allocateTempLocal(
      wasmTypeFor(segment.field.typeId, ctx),
      fnCtx,
      segment.field.typeId,
      ctx,
    );
    ops.push(
      storeLocalValue({
        binding: childTemp,
        value: loaded,
        ctx,
        fnCtx,
      }),
    );
    ownerTemp = childTemp;
  });
  const loaded = ops.pop()!;
  const resultTypeId = binding.typeId!;
  const value = coerceValueToType({
    value: loaded,
    actualType: segments.at(-1)!.field.typeId,
    targetType: resultTypeId,
    ctx,
    fnCtx,
  });
  return ctx.mod.block(
    null,
    [...ops, value],
    binaryen.getExpressionType(value),
  );
};

type ProjectedFieldSegment = {
  ownerTypeId: TypeId;
  ownerInfo: StructuralTypeInfo;
  field: StructuralFieldInfo;
};

const projectedFieldSegments = (
  binding: LocalBindingProjectedField,
  ctx: CodegenContext,
): { segments: readonly ProjectedFieldSegment[] } => {
  let ownerTypeId = binding.rootTypeId;
  const segments = binding.fields.map((name) => {
    const ownerInfo = getStructuralTypeInfo(ownerTypeId, ctx);
    const field = ownerInfo?.fieldMap.get(name);
    if (!ownerInfo || !field) {
      throw new Error(`projected field binding is missing field ${name}`);
    }
    const segment = { ownerTypeId, ownerInfo, field };
    ownerTypeId = field.typeId;
    return segment;
  });
  if (segments.length === 0) {
    throw new Error("projected field binding requires a field path");
  }
  return { segments };
};

export const storeProjectedFieldBindingValue = ({
  binding,
  value,
  valueTypeId,
  ctx,
  fnCtx,
}: {
  binding: LocalBindingProjectedField;
  value: binaryen.ExpressionRef;
  valueTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const { segments } = projectedFieldSegments(binding, ctx);
  const replacementTemp = allocateTempLocal(
    wasmTypeFor(valueTypeId, ctx),
    fnCtx,
    valueTypeId,
    ctx,
  );
  const rootTemp = allocateTempLocal(
    wasmTypeFor(binding.rootTypeId, ctx),
    fnCtx,
    binding.rootTypeId,
    ctx,
  );
  const ops = [
    storeLocalValue({
      binding: replacementTemp,
      value,
      ctx,
      fnCtx,
    }),
    storeLocalValue({
      binding: rootTemp,
      value: loadBindingValue(binding.root, ctx, fnCtx),
      ctx,
      fnCtx,
    }),
  ];
  const ownerTemps = [rootTemp];
  segments.slice(0, -1).forEach((segment) => {
    const childTemp = allocateTempLocal(
      wasmTypeFor(segment.field.typeId, ctx),
      fnCtx,
      segment.field.typeId,
      ctx,
    );
    ops.push(
      storeLocalValue({
        binding: childTemp,
        value: loadStructuralField({
          structInfo: segment.ownerInfo,
          field: segment.field,
          pointer: () => loadLocalValue(ownerTemps.at(-1)!, ctx),
          ctx,
        }),
        ctx,
        fnCtx,
      }),
    );
    ownerTemps.push(childTemp);
  });

  let replacement = loadLocalValue(replacementTemp, ctx);
  let replacementTypeId = valueTypeId;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    const ownerTemp = ownerTemps[index]!;
    if (segment.ownerInfo.layoutKind === "heap-object") {
      ops.push(
        storeStructuralField({
          structInfo: segment.ownerInfo,
          field: segment.field,
          pointer: () => loadLocalValue(ownerTemp, ctx),
          value: coerceValueToType({
            value: replacement,
            actualType: replacementTypeId,
            targetType: segment.field.typeId,
            ctx,
            fnCtx,
          }),
          ctx,
          fnCtx,
        }),
      );
      return ctx.mod.block(null, ops, binaryen.none);
    }
    replacement = rebuildProjectedValueOwner({
      segment,
      ownerTemp,
      replacement,
      replacementTypeId,
      ctx,
      fnCtx,
    });
    replacementTypeId = segment.ownerTypeId;
  }
  ops.push(
    storeProjectedRootValue({
      binding: binding.root,
      value: replacement,
      valueTypeId: replacementTypeId,
      ctx,
      fnCtx,
    }),
  );
  return ctx.mod.block(null, ops, binaryen.none);
};

const rebuildProjectedValueOwner = ({
  segment,
  ownerTemp,
  replacement,
  replacementTypeId,
  ctx,
  fnCtx,
}: {
  segment: ProjectedFieldSegment;
  ownerTemp: LocalBindingLocal;
  replacement: binaryen.ExpressionRef;
  replacementTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef =>
  initStructuralValue({
    structInfo: segment.ownerInfo,
    fieldValues: segment.ownerInfo.fields.map((field) =>
      field.name === segment.field.name
        ? coerceValueToType({
            value: replacement,
            actualType: replacementTypeId,
            targetType: field.typeId,
            ctx,
            fnCtx,
          })
        : loadStructuralField({
            structInfo: segment.ownerInfo,
            field,
            pointer: () => loadLocalValue(ownerTemp, ctx),
            ctx,
          }),
    ),
    ctx,
  });

const storeProjectedRootValue = ({
  binding,
  value,
  valueTypeId,
  ctx,
  fnCtx,
}: {
  binding: LocalBindingProjectedField["root"];
  value: binaryen.ExpressionRef;
  valueTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const targetTypeId = binding.typeId!;
  const coerced = coerceValueToType({
    value,
    actualType: valueTypeId,
    targetType: targetTypeId,
    ctx,
    fnCtx,
  });
  if (binding.kind === "storage-ref") {
    return storeStorageRefBindingValue({ binding, value: coerced, ctx, fnCtx });
  }
  if (binding.kind === "capture") {
    const pointer = loadBindingStorageRef(binding, ctx);
    if (!pointer) {
      throw new Error("projected field root capture requires mutable storage");
    }
    return storeValueIntoStorageRef({
      pointer: () => pointer,
      value: coerced,
      typeId: targetTypeId,
      ctx,
      fnCtx,
    });
  }
  if (binding.kind === "scalar-aggregate") {
    return storeScalarAggregateBindingValue({
      binding,
      value: coerced,
      ctx,
      fnCtx,
    });
  }
  if (binding.kind === "projected-element-ref") {
    return storeProjectedElementBindingValue({
      binding,
      value: coerced,
      ctx,
      fnCtx,
    });
  }
  return storeLocalValue({ binding, value: coerced, ctx, fnCtx });
};

export const storeStorageRefBindingValue = ({
  binding,
  value,
  ctx,
  fnCtx,
}: {
  binding: LocalBindingStorageRef;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  if (!binding.mutable) {
    throw new Error("cannot store through a readonly storage ref binding");
  }
  if (typeof binding.typeId !== "number") {
    throw new Error("storage ref binding is missing its type id");
  }
  return storeValueIntoStorageRef({
    pointer: () => ctx.mod.local.get(binding.index, binding.storageType),
    value,
    typeId: binding.typeId,
    ctx,
    fnCtx,
  });
};

export const loadScalarAggregateBindingField = ({
  binding,
  fieldName,
  ctx,
}: {
  binding: Extract<LocalBinding, { kind: "scalar-aggregate" }>;
  fieldName: string;
  ctx: CodegenContext;
}): binaryen.ExpressionRef | undefined => {
  const fieldBinding = binding.fields.get(fieldName);
  return fieldBinding ? loadLocalValue(fieldBinding, ctx) : undefined;
};

export const storeScalarAggregateBindingField = ({
  binding,
  fieldName,
  value,
  ctx,
  fnCtx,
}: {
  binding: Extract<LocalBinding, { kind: "scalar-aggregate" }>;
  fieldName: string;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  if (!binding.mutable) {
    throw new Error("cannot assign to immutable scalar aggregate binding");
  }
  const fieldBinding = binding.fields.get(fieldName);
  if (!fieldBinding) {
    throw new Error(`scalar aggregate missing field ${fieldName}`);
  }
  return storeLocalValue({
    binding: fieldBinding,
    value,
    ctx,
    fnCtx,
  });
};

export const storeScalarAggregateBindingValue = ({
  binding,
  value,
  ctx,
  fnCtx,
}: {
  binding: Extract<LocalBinding, { kind: "scalar-aggregate" }>;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const temp = allocateTempLocal(binding.type, fnCtx, binding.typeId, ctx);
  const ops: binaryen.ExpressionRef[] = [
    storeLocalValue({
      binding: temp,
      value,
      ctx,
      fnCtx,
    }),
  ];
  binding.structInfo.fields.forEach((field) => {
    const fieldBinding = binding.fields.get(field.name);
    if (!fieldBinding) {
      throw new Error(`scalar aggregate missing field ${field.name}`);
    }
    ops.push(
      storeLocalValue({
        binding: fieldBinding,
        value: loadStructuralField({
          structInfo: binding.structInfo,
          field,
          pointer: () => loadLocalValue(temp, ctx),
          ctx,
        }),
        ctx,
        fnCtx,
      }),
    );
  });
  return ctx.mod.block(null, ops, binaryen.none);
};

const loadScalarAggregateBindingValue = ({
  binding,
  ctx,
  fnCtx,
}: {
  binding: Extract<LocalBinding, { kind: "scalar-aggregate" }>;
  ctx: CodegenContext;
  fnCtx?: FunctionContext;
}): binaryen.ExpressionRef => {
  const fieldValues = binding.structInfo.fields.map((field) => {
    const fieldBinding = binding.fields.get(field.name);
    if (!fieldBinding) {
      throw new Error(`scalar aggregate missing field ${field.name}`);
    }
    const value = loadLocalValue(fieldBinding, ctx);
    if (binding.structInfo.layoutKind === "value-object") {
      return coerceExprToWasmType({
        expr: value,
        targetType: field.wasmType,
        ctx,
      });
    }
    if (!fnCtx) {
      throw new Error("heap scalar aggregate rematerialization requires a function context");
    }
    return lowerValueForHeapField({
      value,
      typeId: field.typeId,
      targetType: field.heapWasmType,
      ctx,
      fnCtx,
    });
  });
  return initStructuralValue({
    structInfo: binding.structInfo,
    fieldValues,
    ctx,
  });
};
