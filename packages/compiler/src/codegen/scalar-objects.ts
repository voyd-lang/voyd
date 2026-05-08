import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  CompileCallOptions,
  ExpressionCompiler,
  FunctionContext,
  FunctionMetadata,
  HirFieldAccessExpr,
  HirMethodCallExpr,
  HirObjectLiteralExpr,
  LocalBindingScalarObject,
  SymbolId,
  TypeId,
} from "./context.js";
import {
  compileCallArgumentsForParams,
  resolveTypedCallArgumentPlan,
  sliceTypedCallArgumentPlan,
} from "./expressions/call/arguments.js";
import { tryInlineResolvedCall } from "./expressions/call/inline.js";
import {
  allocateTempLocal,
  loadLocalValue,
  storeLocalValue,
} from "./locals.js";
import {
  coerceValueToType,
  initStructuralValue,
  lowerValueForHeapField,
} from "./structural.js";
import {
  getExprBinaryenType,
  getRequiredExprType,
  getStructuralTypeInfo,
  wasmTypeFor,
} from "./types.js";
import { coerceExprToWasmType } from "./wasm-type-coercions.js";

export const tryCompileScalarObjectBinding = ({
  symbol,
  initializer,
  targetTypeId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  symbol: SymbolId;
  initializer: HirObjectLiteralExpr;
  targetTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): readonly binaryen.ExpressionRef[] | undefined => {
  const structInfo = getStructuralTypeInfo(targetTypeId, ctx);
  if (!structInfo || structInfo.layoutKind !== "heap-object") {
    return undefined;
  }

  const entriesByName = new Map(
    initializer.entries
      .filter((entry) => entry.kind === "field")
      .map((entry) => [entry.name, entry] as const),
  );
  if (
    entriesByName.size !== initializer.entries.length ||
    entriesByName.size !== structInfo.fields.length
  ) {
    return undefined;
  }

  const fields = new Map<string, ReturnType<typeof allocateTempLocal>>();
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;

  for (const field of structInfo.fields) {
    const local = allocateTempLocal(
      wasmTypeFor(field.typeId, ctx),
      fnCtx,
      field.typeId,
      ctx,
    );
    fields.set(field.name, local);
  }

  const ops = initializer.entries.map((entry) => {
    if (entry.kind !== "field") {
      throw new Error("scalar object binding only supports direct field initializers");
    }
    const field = structInfo.fieldMap.get(entry.name);
    const local = fields.get(entry.name);
    if (!field || !local) {
      throw new Error(`scalar object binding cannot set unknown field ${entry.name}`);
    }
    const actualTypeId = getRequiredExprType(entry.value, ctx, typeInstanceId);
    const value = compileExpr({
      exprId: entry.value,
      ctx,
      fnCtx,
      expectedResultTypeId: field.typeId,
    });
    return (
      storeLocalValue({
        binding: local,
        value: coerceValueToType({
          value: value.expr,
          actualType: actualTypeId,
          targetType: field.typeId,
          ctx,
          fnCtx,
        }),
        ctx,
        fnCtx,
      })
    );
  });

  fnCtx.bindings.set(symbol, {
    kind: "scalar-object",
    type: wasmTypeFor(targetTypeId, ctx),
    storageType: wasmTypeFor(targetTypeId, ctx),
    typeId: targetTypeId,
    fields,
  });

  return ops;
};

export const tryCompileScalarObjectFieldAccess = ({
  expr,
  ctx,
  fnCtx,
}: {
  expr: HirFieldAccessExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): CompiledExpression | undefined => {
  const target = ctx.module.hir.expressions.get(expr.target);
  if (target?.exprKind !== "identifier") {
    return undefined;
  }
  const binding = fnCtx.bindings.get(target.symbol);
  if (binding?.kind !== "scalar-object") {
    return undefined;
  }
  const fieldBinding = binding.fields.get(expr.field);
  if (!fieldBinding || typeof fieldBinding.typeId !== "number") {
    return undefined;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const expectedTypeId = getRequiredExprType(expr.id, ctx, typeInstanceId);
  const expectedWasmType = getExprBinaryenType(expr.id, ctx, typeInstanceId);
  const value = coerceValueToType({
    value: loadLocalValue(fieldBinding, ctx),
    actualType: fieldBinding.typeId,
    targetType: expectedTypeId,
    ctx,
    fnCtx,
  });
  return {
    expr: coerceExprToWasmType({
      expr: value,
      targetType: expectedWasmType,
      ctx,
    }),
    usedReturnCall: false,
  };
};

export const tryCompileScalarObjectFieldAssignment = ({
  targetExpr,
  value,
  valueTypeId,
  ctx,
  fnCtx,
}: {
  targetExpr: HirFieldAccessExpr;
  value: binaryen.ExpressionRef;
  valueTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef | undefined => {
  const target = ctx.module.hir.expressions.get(targetExpr.target);
  if (target?.exprKind !== "identifier") {
    return undefined;
  }
  const binding = fnCtx.bindings.get(target.symbol);
  if (binding?.kind !== "scalar-object") {
    return undefined;
  }
  const fieldBinding = binding.fields.get(targetExpr.field);
  if (!fieldBinding || typeof fieldBinding.typeId !== "number") {
    return undefined;
  }
  return storeLocalValue({
    binding: fieldBinding,
    value: coerceValueToType({
      value,
      actualType: valueTypeId,
      targetType: fieldBinding.typeId,
      ctx,
      fnCtx,
    }),
    ctx,
    fnCtx,
  });
};

export const tryCompileScalarObjectMethodCall = ({
  expr,
  meta,
  ctx,
  fnCtx,
  compileExpr,
  options,
}: {
  expr: HirMethodCallExpr;
  meta: FunctionMetadata;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  options: CompileCallOptions;
}): CompiledExpression | undefined => {
  if (meta.parameters.length === 0 || meta.paramAbiKinds[0] !== "direct") {
    return undefined;
  }

  const target = ctx.module.hir.expressions.get(expr.target);
  if (target?.exprKind !== "identifier") {
    return undefined;
  }
  const binding = fnCtx.bindings.get(target.symbol);
  if (binding?.kind !== "scalar-object") {
    return undefined;
  }

  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const typedPlan = resolveTypedCallArgumentPlan({
    callId: expr.id,
    typeInstanceId,
    ctx,
  });
  const callWithoutReceiver = {
    kind: "expr" as const,
    exprKind: "call" as const,
    id: expr.id,
    ast: expr.ast,
    span: expr.span,
    callee: expr.target,
    args: expr.args,
    typeArguments: expr.typeArguments,
  };
  const args = compileCallArgumentsForParams({
    call: callWithoutReceiver,
    params: meta.parameters.slice(1),
    paramAbiKinds: meta.paramAbiKinds.slice(1),
    ctx,
    fnCtx,
    compileExpr,
    options: {
      typeInstanceId,
      typedPlan: typedPlan
        ? sliceTypedCallArgumentPlan({
            typedPlan,
            paramOffset: 1,
            argOffset: 1,
          })
        : undefined,
    },
  });

  return tryInlineResolvedCall({
    meta,
    args: [undefined, ...args],
    parameterBindings: new Map([[0, binding]]),
    ctx,
    fnCtx,
    compileExpr,
    options,
  });
};

export const materializeScalarObjectBindingValue = ({
  binding,
  ctx,
  fnCtx,
}: {
  binding: LocalBindingScalarObject;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  if (typeof binding.typeId !== "number") {
    throw new Error("scalar object binding is missing a type id");
  }
  const structInfo = getStructuralTypeInfo(binding.typeId, ctx);
  if (!structInfo) {
    throw new Error("scalar object binding is missing structural type information");
  }

  return initStructuralValue({
    structInfo,
    fieldValues: structInfo.fields.map((field) => {
      const fieldBinding = binding.fields.get(field.name);
      if (!fieldBinding) {
        throw new Error(`scalar object binding missing field ${field.name}`);
      }
      return lowerValueForHeapField({
        value: loadLocalValue(fieldBinding, ctx),
        typeId: field.typeId,
        targetType: field.heapWasmType,
        ctx,
        fnCtx,
      });
    }),
    ctx,
  });
};
