import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirCallExpr,
  HirExprId,
  HirFieldAccessExpr,
  HirMethodCallExpr,
  HirPattern,
  LocalBindingProjectedElement,
  SymbolId,
  TypeId,
} from "./context.js";
import type { ProgramSymbolId } from "../semantics/ids.js";
import {
  arrayGet,
  arrayLen,
  structGetFieldValue,
} from "@voyd/lib/binaryen-gc/index.js";
import {
  allocateTempLocal,
  loadProjectedElementBindingValue,
  storeLocalValue,
} from "./locals.js";
import { walkHirExpression } from "./hir-walk.js";
import { coerceValueToType, loadStructuralField } from "./structural.js";
import {
  getDeclaredSymbolTypeId,
  getExprBinaryenType,
  getFixedArrayWasmTypes,
  getRequiredExprType,
  getStructuralTypeInfo,
  getWideValueStorageType,
  isWideValueType,
  wasmHeapFieldTypeFor,
  wasmTypeFor,
} from "./types.js";

type ProjectedElementView = {
  elementTypeId: TypeId;
  arrayTypeId: TypeId;
  arrayLocal: ReturnType<typeof allocateTempLocal>;
  indexLocal: ReturnType<typeof allocateTempLocal>;
  setup: readonly binaryen.ExpressionRef[];
};

export const tryCompileProjectedElementBinding = ({
  symbol,
  initializer,
  targetTypeId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  symbol: SymbolId;
  initializer: HirExprId;
  targetTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): readonly binaryen.ExpressionRef[] | undefined => {
  const projected = tryBuildProjectedElementViewFromExpr({
    exprId: initializer,
    ctx,
    fnCtx,
    compileExpr,
  });
  if (
    !projected ||
    projected.elementTypeId !== targetTypeId ||
    !isWideValueType({ typeId: targetTypeId, ctx })
  ) {
    return undefined;
  }

  fnCtx.bindings.set(symbol, {
    kind: "projected-element-ref",
    type: wasmTypeFor(targetTypeId, ctx),
    storageType: wasmTypeFor(targetTypeId, ctx),
    typeId: targetTypeId,
    arrayIndex: projected.arrayLocal.index,
    indexIndex: projected.indexLocal.index,
    arrayTypeId: projected.arrayTypeId,
  });

  return projected.setup;
};

export const tryCompileProjectedFieldAccess = ({
  expr,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirFieldAccessExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): CompiledExpression | undefined => {
  const projected = tryBuildProjectedElementView({
    targetExprId: expr.target,
    ctx,
    fnCtx,
    compileExpr,
  });
  if (!projected) {
    return undefined;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const expectedFieldTypeId = getRequiredExprType(expr.id, ctx, typeInstanceId);
  const expectedFieldWasmType = getExprBinaryenType(expr.id, ctx, typeInstanceId);
  const structInfo = getStructuralTypeInfo(projected.elementTypeId, ctx);
  const field = structInfo?.fieldMap.get(expr.field);
  if (!structInfo || !field) {
    return undefined;
  }

  const raw = loadProjectedField({
    projected,
    structInfo,
    field,
    ctx,
  });
  const coerced = coerceValueToType({
    value: raw,
    actualType: field.typeId,
    targetType: expectedFieldTypeId,
    ctx,
    fnCtx,
  });

  return {
    expr:
      projected.setup.length === 0
        ? coerced
        : ctx.mod.block(
            null,
            [...projected.setup, coerced],
            expectedFieldWasmType,
          ),
    usedReturnCall: false,
  };
};

export const tryCompileProjectedElementValueExpr = ({
  exprId,
  ctx,
  fnCtx,
  compileExpr,
  expectedResultTypeId,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  expectedResultTypeId?: TypeId;
}): CompiledExpression | undefined => {
  const projected = tryBuildProjectedElementViewFromExpr({
    exprId,
    ctx,
    fnCtx,
    compileExpr,
  });
  if (!projected || !isWideValueType({ typeId: projected.elementTypeId, ctx })) {
    return undefined;
  }

  const binding: LocalBindingProjectedElement = {
    kind: "projected-element-ref",
    type: wasmTypeFor(projected.elementTypeId, ctx),
    storageType: wasmTypeFor(projected.elementTypeId, ctx),
    typeId: projected.elementTypeId,
    arrayIndex: projected.arrayLocal.index,
    indexIndex: projected.indexLocal.index,
    arrayTypeId: projected.arrayTypeId,
  };
  const value = loadProjectedElementBindingValue(binding, ctx);
  const exprValue =
    typeof expectedResultTypeId === "number"
      ? coerceValueToType({
          value,
          actualType: projected.elementTypeId,
          targetType: expectedResultTypeId,
          ctx,
          fnCtx,
        })
      : value;

  return {
    expr:
      projected.setup.length === 0
        ? exprValue
        : ctx.mod.block(
            null,
            [...projected.setup, exprValue],
            binaryen.getExpressionType(exprValue),
          ),
    usedReturnCall: false,
  };
};

export const materializeProjectedElementBinding = ({
  symbol,
  binding,
  ctx,
  fnCtx,
}: {
  symbol: SymbolId;
  binding: LocalBindingProjectedElement;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}) => {
  const owned = allocateTempLocal(binding.type, fnCtx, binding.typeId, ctx);
  const setup = [
    storeLocalValue({
      binding: owned,
      value: loadProjectedElementBindingValue(binding, ctx),
      ctx,
      fnCtx,
    }),
  ];
  fnCtx.bindings.set(symbol, {
    ...owned,
    kind: "local",
    typeId: binding.typeId,
  });
  return { binding: owned, setup };
};

export const tryCompileProjectedElementStorageRefExpr = ({
  exprId,
  paramTypeId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  exprId: HirExprId;
  paramTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): binaryen.ExpressionRef | undefined => {
  const projected = tryBuildProjectedElementViewFromExpr({
    exprId,
    ctx,
    fnCtx,
    compileExpr,
  });
  if (!projected || projected.elementTypeId !== paramTypeId) {
    return undefined;
  }

  const storageType = getWideValueStorageType({ typeId: projected.elementTypeId, ctx });
  const arrayTypes = getFixedArrayWasmTypes(projected.arrayTypeId, ctx);
  if (typeof storageType !== "number" || arrayTypes.kind !== "plain-array") {
    return undefined;
  }

  const pointer = arrayGet(
    ctx.mod,
    ctx.mod.local.get(projected.arrayLocal.index, projected.arrayLocal.type),
    ctx.mod.local.get(projected.indexLocal.index, binaryen.i32),
    storageType,
    false,
  );
  return projected.setup.length === 0
    ? pointer
    : ctx.mod.block(null, [...projected.setup, pointer], storageType);
};

export const tryResolveProjectedElementRootSymbol = ({
  exprId,
  ctx,
  fnCtx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): SymbolId | undefined => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr) {
    return undefined;
  }

  if (expr.exprKind === "call") {
    if (isIntrinsicArrayGetCall({ expr, ctx })) {
      return resolveIdentifierExprSymbol({
        exprId: expr.args[0]!.expr,
        ctx,
      });
    }
    if (isFixedArrayGetCall({ expr, ctx, fnCtx })) {
      return resolveIdentifierExprSymbol({
        exprId: expr.args[0]!.expr,
        ctx,
      });
    }
  }

  if (
    expr.exprKind === "method-call" &&
    isArrayMethodAccess({
      expr,
      methodName: expr.method,
      ctx,
      fnCtx,
    })
  ) {
    return resolveIdentifierExprSymbol({
      exprId: expr.target,
      ctx,
    });
  }

  return undefined;
};

export const tryCompileProjectedOptionalPayloadBinding = ({
  pattern,
  optionalExprId,
  armValueExprId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  pattern: HirPattern;
  optionalExprId: HirExprId;
  armValueExprId: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): readonly binaryen.ExpressionRef[] | undefined => {
  const bindingSymbol = resolveOptionalPayloadBindingSymbol(pattern);
  if (typeof bindingSymbol !== "number") {
    return undefined;
  }

  const rootSymbol = tryResolveProjectedElementRootSymbol({
    exprId: optionalExprId,
    ctx,
    fnCtx,
  });
  const rootAliases =
    typeof rootSymbol === "number"
      ? (fnCtx.simpleIdentifierAliases?.get(rootSymbol) ?? new Set([rootSymbol]))
      : undefined;
  if (
    rootAliases &&
    expressionUsesAnyIdentifier({
      exprId: armValueExprId,
      symbols: rootAliases,
      ctx,
    })
  ) {
    return undefined;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const targetTypeId = getDeclaredSymbolTypeId(bindingSymbol, ctx, typeInstanceId);
  if (!isWideValueType({ typeId: targetTypeId, ctx })) {
    return undefined;
  }
  const projected = tryBuildProjectedElementViewFromOptionalExpr({
    exprId: optionalExprId,
    ctx,
    fnCtx,
    compileExpr,
  });
  if (!projected || projected.elementTypeId !== targetTypeId) {
    return undefined;
  }

  fnCtx.bindings.set(bindingSymbol, {
    kind: "projected-element-ref",
    type: wasmTypeFor(targetTypeId, ctx),
    storageType: wasmTypeFor(targetTypeId, ctx),
    typeId: targetTypeId,
    arrayIndex: projected.arrayLocal.index,
    indexIndex: projected.indexLocal.index,
    arrayTypeId: projected.arrayTypeId,
  });

  return projected.setup;
};

const tryBuildProjectedElementView = ({
  targetExprId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  targetExprId: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): ProjectedElementView | undefined => {
  const targetExpr = ctx.module.hir.expressions.get(targetExprId);
  if (!targetExpr) {
    return undefined;
  }

  if (targetExpr.exprKind === "identifier") {
    const binding = fnCtx.bindings.get(targetExpr.symbol);
    if (binding?.kind === "projected-element-ref") {
      return {
        elementTypeId: binding.typeId!,
        arrayTypeId: binding.arrayTypeId,
        arrayLocal: {
          kind: "local",
          index: binding.arrayIndex,
          type: wasmTypeFor(binding.arrayTypeId, ctx),
          storageType: wasmTypeFor(binding.arrayTypeId, ctx),
          typeId: binding.arrayTypeId,
        },
        indexLocal: {
          kind: "local",
          index: binding.indexIndex,
          type: binaryen.i32,
          storageType: binaryen.i32,
        },
        setup: [],
      };
    }
  }

  return tryBuildProjectedElementViewFromExpr({
    exprId: targetExprId,
    ctx,
    fnCtx,
    compileExpr,
  });
};

const tryBuildProjectedElementViewFromExpr = ({
  exprId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): ProjectedElementView | undefined => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr) {
    return undefined;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const elementTypeId = getRequiredExprType(exprId, ctx, typeInstanceId);
  if (!isWideValueType({ typeId: elementTypeId, ctx })) {
    return undefined;
  }

  if (expr.exprKind === "call") {
    return tryBuildIntrinsicArrayGetView({
      expr,
      elementTypeId,
      ctx,
      fnCtx,
      compileExpr,
    });
  }

  if (expr.exprKind === "method-call") {
    return tryBuildArrayAtView({
      expr,
      elementTypeId,
      ctx,
      fnCtx,
      compileExpr,
    });
  }

  return undefined;
};

const tryBuildProjectedElementViewFromOptionalExpr = ({
  exprId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): ProjectedElementView | undefined => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr) {
    return undefined;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  if (expr.exprKind === "method-call") {
    const targetTypeId = getRequiredExprType(expr.target, ctx, typeInstanceId);
    const targetInfo = getStructuralTypeInfo(targetTypeId, ctx);
    const storageField = targetInfo?.fieldMap.get("storage");
    if (
      !storageField ||
      !isWideValueType({ typeId: storageField.typeId, ctx })
    ) {
      return undefined;
    }
    return tryBuildArrayGetView({
      expr,
      elementTypeId: storageField.typeId,
      ctx,
      fnCtx,
      compileExpr,
    });
  }

  if (expr.exprKind === "call") {
    if (expr.args.length !== 2 || !isFixedArrayGetCall({ expr, ctx, fnCtx })) {
      return undefined;
    }
    const arrayTypeId = getRequiredExprType(expr.args[0]!.expr, ctx, typeInstanceId);
    const desc = ctx.program.types.getTypeDesc(arrayTypeId);
    if (
      desc.kind !== "fixed-array" ||
      !isWideValueType({ typeId: desc.element, ctx })
    ) {
      return undefined;
    }
    return stabilizeNormalizedFixedArrayAccess({
      arrayExprId: expr.args[0]!.expr,
      indexExprId: expr.args[1]!.expr,
      arrayTypeId,
      elementTypeId: desc.element,
      ctx,
      fnCtx,
      compileExpr,
    });
  }

  return undefined;
};

const tryBuildIntrinsicArrayGetView = ({
  expr,
  elementTypeId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirCallExpr;
  elementTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): ProjectedElementView | undefined => {
  if (expr.args.length !== 2 || !isIntrinsicArrayGetCall({ expr, ctx })) {
    return undefined;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const arrayTypeId = getRequiredExprType(expr.args[0]!.expr, ctx, typeInstanceId);
  return stabilizeProjectedArrayAccess({
    arrayExprId: expr.args[0]!.expr,
    indexExprId: expr.args[1]!.expr,
    arrayTypeId,
    elementTypeId,
    ctx,
    fnCtx,
    compileExpr,
  });
};

const tryBuildArrayAtView = ({
  expr,
  elementTypeId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirMethodCallExpr;
  elementTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): ProjectedElementView | undefined => {
  if (
    expr.method !== "at" ||
    expr.args.length !== 1 ||
    !isArrayMethodAccess({
      expr,
      methodName: "at",
      ctx,
      fnCtx,
    })
  ) {
    return undefined;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const targetTypeId = getRequiredExprType(expr.target, ctx, typeInstanceId);
  return tryBuildArrayStorageView({
    targetExprId: expr.target,
    indexExprId: expr.args[0]!.expr,
    targetTypeId,
    elementTypeId,
    ctx,
    fnCtx,
    compileExpr,
  });
};

const tryBuildArrayGetView = ({
  expr,
  elementTypeId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  expr: HirMethodCallExpr;
  elementTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): ProjectedElementView | undefined => {
  if (
    expr.method !== "get" ||
    expr.args.length !== 1 ||
    !isArrayMethodAccess({
      expr,
      methodName: "get",
      ctx,
      fnCtx,
    })
  ) {
    return undefined;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const targetTypeId = getRequiredExprType(expr.target, ctx, typeInstanceId);
  return tryBuildArrayStorageView({
    targetExprId: expr.target,
    indexExprId: expr.args[0]!.expr,
    targetTypeId,
    elementTypeId,
    ctx,
    fnCtx,
    compileExpr,
  });
};

const tryBuildArrayStorageView = ({
  targetExprId,
  indexExprId,
  targetTypeId,
  elementTypeId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  targetExprId: HirExprId;
  indexExprId: HirExprId;
  targetTypeId: TypeId;
  elementTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): ProjectedElementView | undefined => {
  const targetInfo = getStructuralTypeInfo(targetTypeId, ctx);
  const storageField = targetInfo?.fieldMap.get("storage");
  const countField = targetInfo?.fieldMap.get("count");
  if (!targetInfo || !storageField || !countField) {
    return undefined;
  }

  const storageTemp = allocateTempLocal(
    wasmTypeFor(storageField.typeId, ctx),
    fnCtx,
    storageField.typeId,
    ctx,
  );
  const countTemp = allocateTempLocal(binaryen.i32, fnCtx);
  const indexTemp = allocateTempLocal(binaryen.i32, fnCtx);
  const computedIndexTemp = allocateTempLocal(binaryen.i32, fnCtx);
  const targetTemp = allocateTempLocal(
    wasmTypeFor(targetTypeId, ctx),
    fnCtx,
    targetTypeId,
    ctx,
  );
  const targetPointer = () => ctx.mod.local.get(targetTemp.index, targetTemp.type);
  const stableCount = () => ctx.mod.local.get(countTemp.index, binaryen.i32);
  const stableIndex = () => ctx.mod.local.get(indexTemp.index, binaryen.i32);
  const stableComputedIndex = () =>
    ctx.mod.local.get(computedIndexTemp.index, binaryen.i32);

  const setup: binaryen.ExpressionRef[] = [
    storeLocalValue({
      binding: targetTemp,
      value: compileExpr({
        exprId: targetExprId,
        ctx,
        fnCtx,
        expectedResultTypeId: targetTypeId,
      }).expr,
      ctx,
      fnCtx,
    }),
    storeLocalValue({
      binding: storageTemp,
      value: loadStructuralField({
        structInfo: targetInfo,
        field: storageField,
        pointer: targetPointer,
        ctx,
      }),
      ctx,
      fnCtx,
    }),
    storeLocalValue({
      binding: countTemp,
      value: loadStructuralField({
        structInfo: targetInfo,
        field: countField,
        pointer: targetPointer,
        ctx,
      }),
      ctx,
      fnCtx,
    }),
    ctx.mod.local.set(
      indexTemp.index,
      compileExpr({
        exprId: indexExprId,
        ctx,
        fnCtx,
        expectedResultTypeId: countField.typeId,
      }).expr,
    ),
    ctx.mod.local.set(
      computedIndexTemp.index,
      ctx.mod.if(
        ctx.mod.i32.lt_s(stableIndex(), ctx.mod.i32.const(0)),
        ctx.mod.i32.add(stableCount(), stableIndex()),
        stableIndex(),
      ),
    ),
    ctx.mod.if(
      ctx.mod.i32.or(
        ctx.mod.i32.lt_s(stableComputedIndex(), ctx.mod.i32.const(0)),
        ctx.mod.i32.ge_s(stableComputedIndex(), stableCount()),
      ),
      ctx.mod.unreachable(),
    ),
  ];

  return {
    elementTypeId,
    arrayTypeId: storageField.typeId,
    arrayLocal: storageTemp,
    indexLocal: computedIndexTemp,
    setup,
  };
};

const stabilizeNormalizedFixedArrayAccess = ({
  arrayExprId,
  indexExprId,
  arrayTypeId,
  elementTypeId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  arrayExprId: HirExprId;
  indexExprId: HirExprId;
  arrayTypeId: TypeId;
  elementTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): ProjectedElementView => {
  const arrayLocal = allocateTempLocal(
    wasmTypeFor(arrayTypeId, ctx),
    fnCtx,
    arrayTypeId,
    ctx,
  );
  const lengthLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const indexLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const computedIndexLocal = allocateTempLocal(binaryen.i32, fnCtx);
  const arrayRef = () => ctx.mod.local.get(arrayLocal.index, arrayLocal.type);
  const lengthRef = () => ctx.mod.local.get(lengthLocal.index, binaryen.i32);
  const indexRef = () => ctx.mod.local.get(indexLocal.index, binaryen.i32);
  const computedIndexRef = () =>
    ctx.mod.local.get(computedIndexLocal.index, binaryen.i32);

  return {
    elementTypeId,
    arrayTypeId,
    arrayLocal,
    indexLocal: computedIndexLocal,
    setup: [
      storeLocalValue({
        binding: arrayLocal,
        value: compileExpr({
          exprId: arrayExprId,
          ctx,
          fnCtx,
          expectedResultTypeId: arrayTypeId,
        }).expr,
        ctx,
        fnCtx,
      }),
      ctx.mod.local.set(lengthLocal.index, arrayLen(ctx.mod, arrayRef())),
      ctx.mod.local.set(
        indexLocal.index,
        compileExpr({
          exprId: indexExprId,
          ctx,
          fnCtx,
          expectedResultTypeId: ctx.program.primitives.i32,
        }).expr,
      ),
      ctx.mod.local.set(
        computedIndexLocal.index,
        ctx.mod.if(
          ctx.mod.i32.lt_s(indexRef(), ctx.mod.i32.const(0)),
          ctx.mod.i32.add(lengthRef(), indexRef()),
          indexRef(),
        ),
      ),
      ctx.mod.if(
        ctx.mod.i32.or(
          ctx.mod.i32.lt_s(computedIndexRef(), ctx.mod.i32.const(0)),
          ctx.mod.i32.ge_s(computedIndexRef(), lengthRef()),
        ),
        ctx.mod.unreachable(),
      ),
    ],
  };
};

const stabilizeProjectedArrayAccess = ({
  arrayExprId,
  indexExprId,
  arrayTypeId,
  elementTypeId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  arrayExprId: HirExprId;
  indexExprId: HirExprId;
  arrayTypeId: TypeId;
  elementTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): ProjectedElementView => {
  const arrayLocal = allocateTempLocal(
    wasmTypeFor(arrayTypeId, ctx),
    fnCtx,
    arrayTypeId,
    ctx,
  );
  const indexLocal = allocateTempLocal(binaryen.i32, fnCtx);

  return {
    elementTypeId,
    arrayTypeId,
    arrayLocal,
    indexLocal,
    setup: [
      storeLocalValue({
        binding: arrayLocal,
        value: compileExpr({
          exprId: arrayExprId,
          ctx,
          fnCtx,
          expectedResultTypeId: arrayTypeId,
        }).expr,
        ctx,
        fnCtx,
      }),
      ctx.mod.local.set(
        indexLocal.index,
        compileExpr({
          exprId: indexExprId,
          ctx,
          fnCtx,
          expectedResultTypeId: ctx.program.primitives.i32,
        }).expr,
      ),
    ],
  };
};

const loadProjectedField = ({
  projected,
  structInfo,
  field,
  ctx,
}: {
  projected: ProjectedElementView;
  structInfo: NonNullable<ReturnType<typeof getStructuralTypeInfo>>;
  field: NonNullable<ReturnType<typeof getStructuralTypeInfo>>["fields"][number];
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const arrayRef = () =>
    ctx.mod.local.get(projected.arrayLocal.index, projected.arrayLocal.type);
  const indexRef = () =>
    ctx.mod.local.get(projected.indexLocal.index, binaryen.i32);
  const wasmTypes = getFixedArrayWasmTypes(projected.arrayTypeId, ctx);

  if (wasmTypes.kind === "inline-aggregate" && wasmTypes.laneTypes) {
    const lanes = field.inlineWasmTypes.map((laneType, offset) =>
      arrayGet(
        ctx.mod,
        fixedArrayLaneField({
          array: arrayRef(),
          wasmTypes,
          laneIndex: field.inlineStart + offset,
          ctx,
        }),
        indexRef(),
        laneType,
        false,
      ),
    );
    return makeInlineValue(lanes, ctx);
  }

  const element = arrayGet(
    ctx.mod,
    arrayRef(),
    indexRef(),
    wasmHeapFieldTypeFor(projected.elementTypeId, ctx, new Set(), "runtime"),
    false,
  );
  return loadStructuralField({
    structInfo,
    field,
    pointer: () => element,
    ctx,
  });
};

const fixedArrayLaneField = ({
  array,
  wasmTypes,
  laneIndex,
  ctx,
}: {
  array: binaryen.ExpressionRef;
  wasmTypes: ReturnType<typeof getFixedArrayWasmTypes>;
  laneIndex: number;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  if (
    wasmTypes.kind !== "inline-aggregate" ||
    !wasmTypes.laneArrayTypes?.[laneIndex]
  ) {
    throw new Error("inline aggregate fixed array metadata is missing lane arrays");
  }
  return structGetFieldValue({
    mod: ctx.mod,
    fieldIndex: laneIndex + 1,
    fieldType: wasmTypes.laneArrayTypes[laneIndex]!,
    exprRef: array,
  });
};

const resolveCallTarget = ({
  exprId,
  ctx,
  fnCtx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): number | undefined => {
  const callInfo = ctx.program.calls.getCallInfo(ctx.moduleId, exprId);
  const callInstanceId = fnCtx.instanceId ?? fnCtx.typeInstanceId;
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const callInstanceTarget =
    typeof callInstanceId === "number" ? callInfo.targets?.get(callInstanceId) : undefined;
  if (typeof callInstanceTarget === "number") {
    return callInstanceTarget;
  }
  const typeInstanceTarget =
    typeof typeInstanceId === "number" ? callInfo.targets?.get(typeInstanceId) : undefined;
  if (typeof typeInstanceTarget === "number") {
    return typeInstanceTarget;
  }
  return callInfo.targets?.size === 1 ? callInfo.targets.values().next().value : undefined;
};

const resolveIdentifierExprSymbol = ({
  exprId,
  ctx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
}): SymbolId | undefined => {
  const expr = ctx.module.hir.expressions.get(exprId);
  return expr?.exprKind === "identifier" ? expr.symbol : undefined;
};

const isIntrinsicArrayGetCall = ({
  expr,
  ctx,
}: {
  expr: HirCallExpr;
  ctx: CodegenContext;
}): boolean => {
  const callee = ctx.module.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return false;
  }
  const calleeId = ctx.program.symbols.canonicalIdOf(ctx.moduleId, callee.symbol);
  return ctx.program.symbols.getIntrinsicName(calleeId) === "__array_get";
};

const isFixedArrayGetCall = ({
  expr,
  ctx,
  fnCtx,
}: {
  expr: HirCallExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): boolean => {
  if (expr.args.length !== 2) {
    return false;
  }

  const targetFunctionId = resolveCallTarget({ exprId: expr.id, ctx, fnCtx });
  if (
    typeof targetFunctionId !== "number" ||
    ctx.program.symbols.getName(targetFunctionId as ProgramSymbolId) !== "get"
  ) {
    return false;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const arrayTypeId = getRequiredExprType(expr.args[0]!.expr, ctx, typeInstanceId);
  return ctx.program.types.getTypeDesc(arrayTypeId).kind === "fixed-array";
};

const isArrayMethodAccess = ({
  expr,
  methodName,
  ctx,
  fnCtx,
}: {
  expr: HirMethodCallExpr;
  methodName: string;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): boolean => {
  const targetFunctionId = resolveCallTarget({ exprId: expr.id, ctx, fnCtx });
  if (
    typeof targetFunctionId !== "number" ||
    ctx.program.symbols.getName(targetFunctionId as ProgramSymbolId) !== methodName
  ) {
    return false;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const targetTypeId = getRequiredExprType(expr.target, ctx, typeInstanceId);
  const targetInfo = getStructuralTypeInfo(targetTypeId, ctx);
  return Boolean(targetInfo?.fieldMap.get("storage") && targetInfo.fieldMap.get("count"));
};

const resolveOptionalPayloadBindingSymbol = (
  pattern: HirPattern,
): SymbolId | undefined => {
  if (pattern.kind === "identifier") {
    return pattern.symbol;
  }

  if (
    pattern.kind === "destructure" &&
    !pattern.spread &&
    pattern.fields.length === 1 &&
    pattern.fields[0]!.name === "value" &&
    pattern.fields[0]!.pattern.kind === "identifier"
  ) {
    return pattern.fields[0]!.pattern.symbol;
  }

  return undefined;
};

const expressionUsesAnyIdentifier = ({
  exprId,
  symbols,
  ctx,
}: {
  exprId: HirExprId;
  symbols: ReadonlySet<SymbolId>;
  ctx: CodegenContext;
}): boolean => {
  let used = false;
  walkHirExpression({
    exprId,
    ctx,
    visitLambdaBodies: true,
    visitHandlerBodies: true,
    visitor: {
      onExpr: (_exprId, expr) => {
        if (expr.exprKind === "identifier" && symbols.has(expr.symbol)) {
          used = true;
          return "stop";
        }
        return undefined;
      },
    },
  });
  return used;
};

const makeInlineValue = (
  values: readonly binaryen.ExpressionRef[],
  ctx: CodegenContext,
): binaryen.ExpressionRef => {
  if (values.length === 0) {
    return ctx.mod.nop();
  }
  if (values.length === 1) {
    return values[0]!;
  }
  return ctx.mod.tuple.make(values as binaryen.ExpressionRef[]);
};
