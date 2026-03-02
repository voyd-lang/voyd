import binaryen from "binaryen";
import {
  arrayGet,
  arrayLen,
  arrayNew,
  arraySet,
  callRef,
  defineStructType,
  initStruct,
  binaryenTypeToHeapType,
  refCast,
  refFunc,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import { LOOKUP_FIELD_ACCESSOR, RTT_METADATA_SLOTS } from "./rtt/index.js";
import type {
  CodegenContext,
  StructuralFieldInfo,
  FunctionContext,
  StructuralTypeInfo,
  TypeId,
} from "./context.js";
import { allocateTempLocal } from "./locals.js";
import {
  getClosureTypeInfo,
  getFixedArrayWasmTypes,
  getStructuralTypeInfo,
  wasmHeapFieldTypeFor,
  wasmTypeFor,
} from "./types.js";
import { wrapValueInOutcome } from "./effects/outcome-values.js";
import { coerceExprToWasmType } from "./wasm-type-coercions.js";

const defaultValueForWasmType = (
  wasmType: binaryen.Type,
  ctx: CodegenContext,
): binaryen.ExpressionRef => {
  if (wasmType === binaryen.i32) return ctx.mod.i32.const(0);
  if (wasmType === binaryen.i64) return ctx.mod.i64.const(0, 0);
  if (wasmType === binaryen.f32) return ctx.mod.f32.const(0);
  if (wasmType === binaryen.f64) return ctx.mod.f64.const(0);
  return ctx.mod.ref.null(wasmType);
};

const typeHasTraitRequirements = (
  typeId: TypeId,
  ctx: CodegenContext,
): boolean => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  return desc.kind === "intersection" && (desc.traits?.length ?? 0) > 0;
};

const pickUnionCoercionTarget = ({
  actualType,
  targetType,
  ctx,
}: {
  actualType: TypeId;
  targetType: TypeId;
  ctx: CodegenContext;
}): TypeId | undefined => {
  const targetDesc = ctx.program.types.getTypeDesc(targetType);
  if (targetDesc.kind !== "union") {
    return undefined;
  }

  const members: TypeId[] = [];
  const collect = (typeId: TypeId, seen: Set<TypeId>): void => {
    if (seen.has(typeId)) {
      return;
    }
    seen.add(typeId);
    const desc = ctx.program.types.getTypeDesc(typeId);
    if (desc.kind === "union") {
      desc.members.forEach((member) => collect(member, seen));
      return;
    }
    members.push(typeId);
  };
  collect(targetType, new Set<TypeId>());

  // Prefer exact matches to avoid "surprising" coercions when a value already
  // belongs to a specific union member but could also unify with other members
  // (e.g. structural width subtyping).
  if (members.includes(actualType)) {
    return actualType;
  }

  return members.find((member) => {
    const check = ctx.program.types.unify(actualType, member, {
      location: ctx.module.hir.module.ast,
      reason: "union coercion",
      variance: "covariant",
      allowUnknown: true,
    });
    return check.ok;
  });
};

export const requiresStructuralConversion = (
  actualType: TypeId,
  targetType: TypeId | undefined,
  ctx: CodegenContext
): boolean => {
  if (typeof targetType !== "number" || actualType === targetType) {
    return false;
  }

  if (typeHasTraitRequirements(targetType, ctx)) {
    return false;
  }

  const targetInfo = getStructuralTypeInfo(targetType, ctx);
  if (!targetInfo) {
    return false;
  }

  const actualInfo = getStructuralTypeInfo(actualType, ctx);
  if (!actualInfo) {
    return false;
  }

  return actualInfo.structuralId !== targetInfo.structuralId;
};

export const coerceValueToType = ({
  value,
  actualType,
  targetType,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  actualType: TypeId;
  targetType: TypeId | undefined;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  if (typeof targetType !== "number" || actualType === targetType) {
    return value;
  }

  const targetDesc = ctx.program.types.getTypeDesc(targetType);
  const actualDesc = ctx.program.types.getTypeDesc(actualType);

  if (targetDesc.kind === "recursive") {
    const unfolded = ctx.program.types.substitute(
      targetDesc.body,
      new Map([[targetDesc.binder, targetType]]),
    );
    return coerceValueToType({
      value,
      actualType,
      targetType: unfolded,
      ctx,
      fnCtx,
    });
  }

  if (actualDesc.kind === "recursive") {
    const unfolded = ctx.program.types.substitute(
      actualDesc.body,
      new Map([[actualDesc.binder, actualType]]),
    );
    return coerceValueToType({
      value,
      actualType: unfolded,
      targetType,
      ctx,
      fnCtx,
    });
  }

  const optionalInfo = ctx.program.optionals.getOptionalInfo(ctx.moduleId, targetType);

  if (optionalInfo) {
    const someInfo = getStructuralTypeInfo(optionalInfo.someType, ctx);
    if (!someInfo) {
      throw new Error("Optional wrapping requires structural type info for Some member");
    }
    if (someInfo.fields.length !== 1) {
      throw new Error("Optional Some member must contain exactly one field");
    }

    const comparison = ctx.program.types.unify(actualType, optionalInfo.innerType, {
      location: ctx.module.hir.module.ast,
      reason: "optional Some coercion",
      variance: "covariant",
      allowUnknown: true,
    });
    if (comparison.ok) {
      const inner = coerceValueToType({
        value,
        actualType,
        targetType: optionalInfo.innerType,
        ctx,
        fnCtx,
      });
      const someField = someInfo.fields[0]!;
      const innerValue = coerceExprToWasmType({
        expr: inner,
        targetType: someField.heapWasmType,
        ctx,
      });
      return initStruct(ctx.mod, someInfo.runtimeType, [
        ctx.mod.global.get(
          someInfo.ancestorsGlobal,
          ctx.rtt.extensionHelpers.i32Array
        ),
        ctx.mod.global.get(
          someInfo.fieldTableGlobal,
          ctx.rtt.fieldLookupHelpers.lookupTableType
        ),
        ctx.mod.global.get(
          someInfo.methodTableGlobal,
          ctx.rtt.methodLookupHelpers.lookupTableType
        ),
        innerValue,
      ]);
    }
  }

  if (targetDesc.kind === "union") {
    const memberTarget = pickUnionCoercionTarget({
      actualType,
      targetType,
      ctx,
    });
    return typeof memberTarget === "number"
      ? coerceValueToType({
          value,
          actualType,
          targetType: memberTarget,
          ctx,
          fnCtx,
        })
      : value;
  }

  if (targetDesc.kind === "fixed-array" && actualDesc.kind === "fixed-array") {
    const targetElementType = targetDesc.element;
    const actualElementType = actualDesc.element;
    const compatible = ctx.program.types.unify(actualElementType, targetElementType, {
      location: ctx.module.hir.module.ast,
      reason: "fixed-array coercion",
      variance: "covariant",
      allowUnknown: true,
    });
    if (!compatible.ok) {
      return value;
    }

    const actualArrayType = wasmTypeFor(actualType, ctx);
    const targetArrayInfo = getFixedArrayWasmTypes(targetType, ctx);
    const targetArrayType = targetArrayInfo.type;
    if (actualArrayType === targetArrayType) {
      return value;
    }

    const actualElementWasmType = wasmHeapFieldTypeFor(
      actualElementType,
      ctx,
      new Set(),
      "runtime",
    );
    const targetElementWasmType = wasmHeapFieldTypeFor(
      targetElementType,
      ctx,
      new Set(),
      "runtime",
    );

    const actualTemp = allocateTempLocal(actualArrayType, fnCtx);
    const targetTemp = allocateTempLocal(targetArrayType, fnCtx);
    const lengthTemp = allocateTempLocal(binaryen.i32, fnCtx);
    const indexTemp = allocateTempLocal(binaryen.i32, fnCtx);

    const actualRef = (): binaryen.ExpressionRef =>
      ctx.mod.local.get(actualTemp.index, actualArrayType);
    const targetRef = (): binaryen.ExpressionRef =>
      ctx.mod.local.get(targetTemp.index, targetArrayType);
    const len = (): binaryen.ExpressionRef =>
      ctx.mod.local.get(lengthTemp.index, binaryen.i32);
    const idx = (): binaryen.ExpressionRef =>
      ctx.mod.local.get(indexTemp.index, binaryen.i32);

    const breakLabel = `coerce_fixed_array_break_${actualType}_${targetType}_${targetTemp.index}`;
    const loopLabel = `coerce_fixed_array_loop_${actualType}_${targetType}_${targetTemp.index}`;

    const init = defaultValueForWasmType(targetElementWasmType, ctx);
    const buildTarget = ctx.mod.local.set(
      targetTemp.index,
      arrayNew(ctx.mod, targetArrayInfo.heapType, len(), init),
    );

    const element = arrayGet(ctx.mod, actualRef(), idx(), actualElementWasmType, false);
    const coercedElement = coerceValueToType({
      value: element,
      actualType: actualElementType,
      targetType: targetElementType,
      ctx,
      fnCtx,
    });
    const storedElement = coerceExprToWasmType({
      expr: coercedElement,
      targetType: targetElementWasmType,
      ctx,
    });

    const loopBody = ctx.mod.block(null, [
      ctx.mod.if(ctx.mod.i32.ge_u(idx(), len()), ctx.mod.br(breakLabel)),
      arraySet(ctx.mod, targetRef(), idx(), storedElement),
      ctx.mod.local.set(indexTemp.index, ctx.mod.i32.add(idx(), ctx.mod.i32.const(1))),
      ctx.mod.br(loopLabel),
    ]);

    const loop = ctx.mod.block(
      breakLabel,
      [ctx.mod.loop(loopLabel, loopBody)],
      binaryen.none,
    );

    return ctx.mod.block(
      null,
      [
        ctx.mod.local.set(actualTemp.index, value),
        ctx.mod.local.set(lengthTemp.index, arrayLen(ctx.mod, actualRef())),
        buildTarget,
        ctx.mod.local.set(indexTemp.index, ctx.mod.i32.const(0)),
        loop,
        targetRef(),
      ],
      targetArrayType,
    );
  }

  if (targetDesc.kind === "function" && actualDesc.kind === "function") {
    const targetEffectful =
      typeof targetDesc.effectRow === "number" &&
      !ctx.program.effects.isEmpty(targetDesc.effectRow);
    const actualEffectful =
      typeof actualDesc.effectRow === "number" &&
      !ctx.program.effects.isEmpty(actualDesc.effectRow);

    if (targetEffectful && !actualEffectful) {
      return coercePureClosureToEffectful({
        value,
        actualType,
        targetType,
        ctx,
      });
    }
  }

  if (typeHasTraitRequirements(targetType, ctx)) {
    return value;
  }

  const targetInfo = getStructuralTypeInfo(targetType, ctx);
  if (!targetInfo) {
    return value;
  }

  const actualInfo = getStructuralTypeInfo(actualType, ctx);
  if (!actualInfo) {
    throw new Error("cannot coerce non-structural value to structural type");
  }
  if (actualInfo.structuralId === targetInfo.structuralId) {
    return value;
  }

  const tryArrayLikeConversion = (): binaryen.ExpressionRef | undefined => {
    const actualCount = actualInfo.fieldMap.get("count");
    const actualStorage = actualInfo.fieldMap.get("storage");
    const targetCount = targetInfo.fieldMap.get("count");
    const targetStorage = targetInfo.fieldMap.get("storage");
    if (!actualCount || !actualStorage || !targetCount || !targetStorage) {
      return undefined;
    }
    if (actualInfo.fields.length !== 2 || targetInfo.fields.length !== 2) {
      return undefined;
    }
    if (actualCount.wasmType !== binaryen.i32 || targetCount.wasmType !== binaryen.i32) {
      return undefined;
    }

    const isFixedArray = (typeId: TypeId): boolean => {
      const desc = ctx.program.types.getTypeDesc(typeId);
      if (desc.kind === "fixed-array") {
        return true;
      }
      if (desc.kind !== "recursive") {
        return false;
      }
      const unfolded = ctx.program.types.substitute(
        desc.body,
        new Map([[desc.binder, typeId]]),
      );
      return isFixedArray(unfolded);
    };
    if (!isFixedArray(actualStorage.typeId) || !isFixedArray(targetStorage.typeId)) {
      return undefined;
    }

    const temp = allocateTempLocal(actualInfo.interfaceType, fnCtx);
    const stored = ctx.mod.local.get(temp.index, actualInfo.interfaceType);
    const casted = refCast(ctx.mod, stored, actualInfo.runtimeType);

    const countValue = structGetFieldValue({
      mod: ctx.mod,
      fieldType: binaryen.i32,
      fieldIndex: actualCount.runtimeIndex,
      exprRef: casted,
    });
    const storageValue = structGetFieldValue({
      mod: ctx.mod,
      fieldType: actualStorage.heapWasmType,
      fieldIndex: actualStorage.runtimeIndex,
      exprRef: casted,
    });
    const storageCoerced = coerceValueToType({
      value: storageValue,
      actualType: actualStorage.typeId,
      targetType: targetStorage.typeId,
      ctx,
      fnCtx,
    });

    const storedStorage = coerceExprToWasmType({
      expr: storageCoerced,
      targetType: targetStorage.heapWasmType,
      ctx,
    });

    const converted = initStruct(ctx.mod, targetInfo.runtimeType, [
      ctx.mod.global.get(
        targetInfo.ancestorsGlobal,
        ctx.rtt.extensionHelpers.i32Array
      ),
      ctx.mod.global.get(
        targetInfo.fieldTableGlobal,
        ctx.rtt.fieldLookupHelpers.lookupTableType
      ),
      ctx.mod.global.get(
        targetInfo.methodTableGlobal,
        ctx.rtt.methodLookupHelpers.lookupTableType
      ),
      countValue,
      storedStorage,
    ]);

    return ctx.mod.block(
      null,
      [ctx.mod.local.set(temp.index, value), converted],
      targetInfo.interfaceType,
    );
  };

  if (actualInfo.typeId === targetInfo.typeId) {
    return value;
  }

  const arrayLike = tryArrayLikeConversion();
  if (arrayLike) {
    return arrayLike;
  }

  return emitStructuralConversion({
    value,
    actual: actualInfo,
    target: targetInfo,
    ctx,
    fnCtx,
  });
};

const coercePureClosureToEffectful = ({
  value,
  actualType,
  targetType,
  ctx,
}: {
  value: binaryen.ExpressionRef;
  actualType: TypeId;
  targetType: TypeId;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const key = `${actualType}->${targetType}`;
  const cache = ctx.effectsState.closureCoercions;
  const cached = cache.get(key);
  if (cached) {
    return initStruct(ctx.mod, cached.envType, [
      refFunc(ctx.mod, cached.fnName, cached.fnRefType),
      value,
    ]);
  }

  const actualClosure = getClosureTypeInfo(actualType, ctx);
  const targetClosure = getClosureTypeInfo(targetType, ctx);
  const wrapperIndex = cache.size;
  const fnName = `__voyd_effect_closure_wrap_${wrapperIndex}_${actualType}_${targetType}`;
  const envType = defineStructType(ctx.mod, {
    name: `__voydEffectClosureWrapEnv_${wrapperIndex}`,
    fields: [
      { name: "__fn", type: binaryen.funcref, mutable: false },
      { name: "inner", type: actualClosure.interfaceType, mutable: false },
    ],
    supertype: binaryenTypeToHeapType(targetClosure.interfaceType),
    final: true,
  });
  const fnRefType = targetClosure.fnRefType;

  const params = binaryen.createType([
    targetClosure.interfaceType,
    ...targetClosure.paramTypes,
  ] as number[]);

  const innerEnv = () =>
    refCast(ctx.mod, ctx.mod.local.get(0, targetClosure.interfaceType), envType);
  const innerClosure = () =>
    structGetFieldValue({
      mod: ctx.mod,
      fieldIndex: 1,
      fieldType: actualClosure.interfaceType,
      exprRef: innerEnv(),
    });
  const innerFnField = structGetFieldValue({
    mod: ctx.mod,
    fieldIndex: 0,
    fieldType: binaryen.funcref,
    exprRef: innerClosure(),
  });
  const innerTarget =
    actualClosure.fnRefType === binaryen.funcref
      ? innerFnField
      : refCast(ctx.mod, innerFnField, actualClosure.fnRefType);

  const userArgsStart = 2; // [self, handler, ...userArgs]
  const callArgs = [
    innerClosure(),
    ...targetClosure.paramTypes
      .slice(1)
      .map((type, index) => ctx.mod.local.get(userArgsStart + index, type)),
  ];
  const innerResult = callRef(
    ctx.mod,
    innerTarget,
    callArgs as number[],
    actualClosure.resultType
  );
  const innerValueType = wasmTypeFor(actualDescReturnTypeId(actualType, ctx), ctx);
  const wrapped =
    binaryen.getExpressionType(innerResult) === innerValueType
      ? wrapValueInOutcome({ valueExpr: innerResult, valueType: innerValueType, ctx })
      : innerResult;

  ctx.mod.addFunction(
    fnName,
    params,
    targetClosure.resultType,
    [],
    wrapped
  );
  cache.set(key, { envType, fnName, fnRefType });

  return initStruct(ctx.mod, envType, [refFunc(ctx.mod, fnName, fnRefType), value]);
};

const actualDescReturnTypeId = (typeId: TypeId, ctx: CodegenContext): TypeId => {
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind !== "function") {
    throw new Error("expected function type for closure coercion");
  }
  return desc.returnType;
};

export const emitStructuralConversion = ({
  value,
  actual,
  target,
  ctx,
  fnCtx,
}: {
  value: binaryen.ExpressionRef;
  actual: StructuralTypeInfo;
  target: StructuralTypeInfo;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  target.fields.forEach((field) => {
    if (!actual.fieldMap.has(field.name)) {
      throw new Error(
        `structural value missing field ${field.name} required for conversion`
      );
    }
  });

  const temp = allocateTempLocal(actual.interfaceType, fnCtx);
  const ops: binaryen.ExpressionRef[] = [ctx.mod.local.set(temp.index, value)];
  const sourceRef = ctx.mod.local.get(temp.index, actual.interfaceType);

  const shouldDirectFixedArrayLoad = (typeId: TypeId): boolean => {
    const desc = ctx.program.types.getTypeDesc(typeId);
    if (desc.kind === "fixed-array") {
      const elementDesc = ctx.program.types.getTypeDesc(desc.element);
      // Primitive-element fixed arrays don't suffer from the signature invariance
      // issues that arise for reference-element arrays, and their accessors are
      // safe to invoke via field tables.
      return elementDesc.kind !== "primitive";
    }
    if (desc.kind !== "recursive") {
      return false;
    }
    const unfolded = ctx.program.types.substitute(
      desc.body,
      new Map([[desc.binder, typeId]]),
    );
    return shouldDirectFixedArrayLoad(unfolded);
  };

  const fieldValues = target.fields.map((field) => {
    const sourceField = actual.fieldMap.get(field.name)!;
    const raw = shouldDirectFixedArrayLoad(sourceField.typeId)
      ? (() => {
          const casted = refCast(ctx.mod, sourceRef, actual.runtimeType);
          const loaded = structGetFieldValue({
            mod: ctx.mod,
            fieldType: sourceField.heapWasmType,
            fieldIndex: sourceField.runtimeIndex,
            exprRef: casted,
          });
          return sourceField.wasmType === sourceField.heapWasmType
            ? loaded
            : ctx.mod.block(null, [loaded], sourceField.wasmType);
        })()
      : loadStructuralField({
          structInfo: actual,
          field: sourceField,
          pointer: sourceRef,
          ctx,
        });
    const coerced = coerceValueToType({
      value: raw,
      actualType: sourceField.typeId,
      targetType: field.typeId,
      ctx,
      fnCtx,
    });
    return coerceExprToWasmType({
      expr: coerced,
      targetType: field.heapWasmType,
      ctx,
    });
  });

  const converted = initStruct(ctx.mod, target.runtimeType, [
    ctx.mod.global.get(
      target.ancestorsGlobal,
      ctx.rtt.extensionHelpers.i32Array
    ),
    ctx.mod.global.get(
      target.fieldTableGlobal,
      ctx.rtt.fieldLookupHelpers.lookupTableType
    ),
    ctx.mod.global.get(
      target.methodTableGlobal,
      ctx.rtt.methodLookupHelpers.lookupTableType
    ),
    ...fieldValues,
  ]);
  ops.push(converted);
  return ctx.mod.block(null, ops, target.interfaceType);
};

export const loadStructuralField = ({
  structInfo: _structInfo,
  field,
  pointer,
  ctx,
}: {
  structInfo: StructuralTypeInfo;
  field: StructuralTypeInfo["fields"][number];
  pointer: binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const lookupTable = structGetFieldValue({
    mod: ctx.mod,
    fieldType: ctx.rtt.fieldLookupHelpers.lookupTableType,
    fieldIndex: RTT_METADATA_SLOTS.FIELD_INDEX_TABLE,
    exprRef: pointer,
  });
  const accessor = ctx.mod.call(
    LOOKUP_FIELD_ACCESSOR,
    [ctx.mod.i32.const(field.hash), lookupTable, ctx.mod.i32.const(0)],
    binaryen.funcref,
  );
  const getter = refCast(ctx.mod, accessor, field.getterType!);
  return callRef(ctx.mod, getter, [pointer], field.wasmType);
};

export const storeStructuralField = ({
  structInfo: _structInfo,
  field,
  pointer,
  value,
  ctx,
}: {
  structInfo: StructuralTypeInfo;
  field: StructuralFieldInfo;
  pointer: binaryen.ExpressionRef;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (!field.setterType) {
    throw new Error(`missing setter for structural field ${field.name}`);
  }
  const lookupTable = structGetFieldValue({
    mod: ctx.mod,
    fieldType: ctx.rtt.fieldLookupHelpers.lookupTableType,
    fieldIndex: RTT_METADATA_SLOTS.FIELD_INDEX_TABLE,
    exprRef: pointer,
  });
  const accessor = ctx.mod.call(
    LOOKUP_FIELD_ACCESSOR,
    [ctx.mod.i32.const(field.hash), lookupTable, ctx.mod.i32.const(1)],
    binaryen.funcref,
  );
  const setter = refCast(ctx.mod, accessor, field.setterType);
  const storedValue =
    field.wasmType === field.heapWasmType
      ? value
      : coerceExprToWasmType({ expr: value, targetType: field.heapWasmType, ctx });
  return callRef(ctx.mod, setter, [pointer, storedValue], binaryen.none);
};
