import binaryen from "binaryen";
import type {
  CodegenContext,
  CompiledExpression,
  ExpressionCompiler,
  FunctionContext,
  HirAssignExpr,
  HirFieldAccessExpr,
  LocalBinding,
  StructuralFieldInfo,
  StructuralTypeInfo,
  TypeId,
} from "../context.js";
import { compilePatternInitialization } from "../patterns.js";
import {
  coerceValueToType,
  initStructuralValue,
  lowerValueForHeapField,
  loadStructuralField,
  storeStructuralField,
} from "../structural.js";
import { maybeReportValueBoxingNote } from "../value-boxing-notes.js";
import {
  allocateTempLocal,
  getRequiredBinding,
  loadLocalValue,
  materializeOwnedBinding,
  storeStorageRefBindingValue,
  storeLocalValue,
} from "../locals.js";
import {
  getRequiredExprType,
  getStructuralTypeInfo,
  getSymbolTypeId,
  wasmTypeFor,
} from "../types.js";
import { refCast, structSetFieldValue } from "@voyd/lib/binaryen-gc/index.js";
import type { ProgramFunctionInstanceId } from "../../semantics/ids.js";

const storeIntoBinding = ({
  binding,
  value,
  targetTypeId,
  actualTypeId,
  ctx,
  fnCtx,
}: {
  binding: LocalBinding;
  value: binaryen.ExpressionRef;
  targetTypeId: TypeId;
  actualTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const coerced = coerceValueToType({
    value,
    actualType: actualTypeId,
    targetType: targetTypeId,
    ctx,
    fnCtx,
  });

  if (binding.kind === "capture") {
    if (!binding.mutable) {
      throw new Error("cannot assign to immutable capture");
    }
    const envRef = ctx.mod.local.get(binding.envIndex, binding.envSuperType);
    const typedEnv =
      binding.envType === binding.envSuperType
        ? envRef
        : refCast(ctx.mod, envRef, binding.envType);
    return structSetFieldValue({
      mod: ctx.mod,
      fieldIndex: binding.fieldIndex,
      ref: typedEnv,
      value: coerced,
    });
  }

  if (binding.kind === "storage-ref") {
    return storeStorageRefBindingValue({
      binding,
      value: coerced,
      ctx,
      fnCtx,
    });
  }
  if (binding.kind === "projected-element-ref") {
    throw new Error("cannot assign to a projected element binding");
  }

  return storeLocalValue({ binding, value: coerced, ctx, fnCtx });
};

type FieldAssignmentSegment = {
  ownerTypeId: TypeId;
  ownerInfo: StructuralTypeInfo;
  field: StructuralFieldInfo;
};

const collectFieldAssignmentSegments = ({
  expr,
  ctx,
  typeInstanceId,
}: {
  expr: HirFieldAccessExpr;
  ctx: CodegenContext;
  typeInstanceId: ProgramFunctionInstanceId | undefined;
}): {
  rootExprId: number;
  segments: readonly FieldAssignmentSegment[];
} => {
  const parentExpr = ctx.module.hir.expressions.get(expr.target);
  if (parentExpr?.exprKind === "field-access") {
    const parent = collectFieldAssignmentSegments({
      expr: parentExpr,
      ctx,
      typeInstanceId,
    });
    const ownerTypeId = getRequiredExprType(expr.target, ctx, typeInstanceId);
    const ownerInfo = getStructuralTypeInfo(ownerTypeId, ctx);
    if (!ownerInfo) {
      throw new Error("field assignment requires a structural object");
    }
    const field = ownerInfo.fieldMap.get(expr.field);
    if (!field) {
      throw new Error(`object does not contain field ${expr.field}`);
    }
    return {
      rootExprId: parent.rootExprId,
      segments: [...parent.segments, { ownerTypeId, ownerInfo, field }],
    };
  }

  const ownerTypeId = getRequiredExprType(expr.target, ctx, typeInstanceId);
  const ownerInfo = getStructuralTypeInfo(ownerTypeId, ctx);
  if (!ownerInfo) {
    throw new Error("field assignment requires a structural object");
  }
  const field = ownerInfo.fieldMap.get(expr.field);
  if (!field) {
    throw new Error(`object does not contain field ${expr.field}`);
  }

  return {
    rootExprId: expr.target,
    segments: [{ ownerTypeId, ownerInfo, field }],
  };
};

const rebuildValueOwner = ({
  ownerInfo,
  ownerTemp,
  replacedField,
  replacementValue,
  replacementTypeId,
  ctx,
  fnCtx,
}: {
  ownerInfo: StructuralTypeInfo;
  ownerTemp: ReturnType<typeof allocateTempLocal>;
  replacedField: StructuralFieldInfo;
  replacementValue: binaryen.ExpressionRef;
  replacementTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef =>
  initStructuralValue({
    structInfo: ownerInfo,
    fieldValues: ownerInfo.fields.map((candidate) =>
      candidate.name === replacedField.name
        ? coerceValueToType({
            value: replacementValue,
            actualType: replacementTypeId,
            targetType: candidate.typeId,
            ctx,
            fnCtx,
          })
        : loadStructuralField({
            structInfo: ownerInfo,
            field: candidate,
            pointer: () => loadLocalValue(ownerTemp, ctx),
            ctx,
          }),
    ),
    ctx,
  });

const compileFieldAssignment = ({
  targetExpr,
  value,
  valueTypeId,
  ctx,
  fnCtx,
  compileExpr,
}: {
  targetExpr: HirFieldAccessExpr;
  value: binaryen.ExpressionRef;
  valueTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): binaryen.ExpressionRef => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const { rootExprId, segments } = collectFieldAssignmentSegments({
    expr: targetExpr,
    ctx,
    typeInstanceId,
  });
  const rootTypeId = getRequiredExprType(rootExprId, ctx, typeInstanceId);
  const rootTemp = allocateTempLocal(
    wasmTypeFor(rootTypeId, ctx),
    fnCtx,
    rootTypeId,
    ctx,
  );
  const ops: binaryen.ExpressionRef[] = [
    storeLocalValue({
      binding: rootTemp,
      value: compileExpr({
        exprId: rootExprId,
        ctx,
        fnCtx,
        expectedResultTypeId: rootTypeId,
      }).expr,
      ctx,
      fnCtx,
    }),
  ];

  const ownerTemps = [rootTemp];
  segments.slice(0, -1).forEach((segment, index) => {
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
          pointer: () => loadLocalValue(ownerTemps[index]!, ctx),
          ctx,
        }),
        ctx,
        fnCtx,
      }),
    );
    ownerTemps.push(childTemp);
  });

  let replacementValue = value;
  let replacementTypeId = valueTypeId;

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    const ownerTemp = ownerTemps[index]!;
    if (segment.ownerInfo.layoutKind === "heap-object") {
      maybeReportValueBoxingNote({
        valueTypeId: segment.field.typeId,
        context: `mutation of object field '${segment.field.name}'`,
        span: targetExpr.span,
        ctx,
      });
      ops.push(
        storeStructuralField({
          structInfo: segment.ownerInfo,
          field: segment.field,
          pointer: () => loadLocalValue(ownerTemp, ctx),
          value: coerceValueToType({
            value: replacementValue,
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

    replacementValue = rebuildValueOwner({
      ownerInfo: segment.ownerInfo,
      ownerTemp,
      replacedField: segment.field,
      replacementValue,
      replacementTypeId,
      ctx,
      fnCtx,
    });
    replacementTypeId = segment.ownerTypeId;
  }

  const rootExpr = ctx.module.hir.expressions.get(rootExprId);
  if (rootExpr?.exprKind !== "identifier") {
    throw new Error(
      "inline value-object field assignment requires an addressable root binding",
    );
  }

  const binding = getRequiredBinding(rootExpr.symbol, ctx, fnCtx);
  const materialized =
    binding.kind === "storage-ref" && !binding.mutable
      ? materializeOwnedBinding({
          symbol: rootExpr.symbol,
          ctx,
          fnCtx,
        })
      : undefined;
  if (materialized) {
    ops.push(...materialized.setup);
  }
  const targetBinding = materialized?.binding ?? binding;
  ops.push(
    storeIntoBinding({
      binding: targetBinding,
      value: replacementValue,
      targetTypeId: targetBinding.typeId ?? rootTypeId,
      actualTypeId: replacementTypeId,
      ctx,
      fnCtx,
    }),
  );
  return ctx.mod.block(null, ops, binaryen.none);
};

export const compileAssignExpr = (
  expr: HirAssignExpr,
  ctx: CodegenContext,
  fnCtx: FunctionContext,
  compileExpr: ExpressionCompiler
): CompiledExpression => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  if (expr.pattern) {
    const ops: binaryen.ExpressionRef[] = [];
    compilePatternInitialization({
      pattern: expr.pattern,
      initializer: expr.value,
      ctx,
      fnCtx,
      ops,
      compileExpr,
      options: { declare: false },
    });
    const opExpr =
      ops.length === 1 ? ops[0]! : ctx.mod.block(null, ops, binaryen.none);
    return { expr: opExpr, usedReturnCall: false };
  }

  if (typeof expr.target !== "number") {
    throw new Error("assignment missing target expression");
  }

  const targetExpr = ctx.module.hir.expressions.get(expr.target);
  if (!targetExpr) {
    throw new Error("assignment missing target expression");
  }

  const valueTypeId = getRequiredExprType(expr.value, ctx, typeInstanceId);

  if (targetExpr.exprKind === "field-access") {
    const targetTypeId = getRequiredExprType(
      expr.target,
      ctx,
      typeInstanceId
    );
    const valueExpr = compileExpr({
      exprId: expr.value,
      ctx,
      fnCtx,
      expectedResultTypeId: targetTypeId,
    });
    const coerced = coerceValueToType({
      value: valueExpr.expr,
      actualType: valueTypeId,
      targetType: targetTypeId,
      ctx,
      fnCtx,
    });
    return {
      expr: compileFieldAssignment({
        targetExpr,
        value: coerced,
        valueTypeId: targetTypeId,
        ctx,
        fnCtx,
        compileExpr,
      }),
      usedReturnCall: false,
    };
  }

  if (targetExpr.exprKind !== "identifier") {
    throw new Error("only identifier assignments are supported today");
  }

  const binding = getRequiredBinding(targetExpr.symbol, ctx, fnCtx);
  const targetTypeId = getSymbolTypeId(targetExpr.symbol, ctx, typeInstanceId);
  const valueExpr = compileExpr({
    exprId: expr.value,
    ctx,
    fnCtx,
    expectedResultTypeId: targetTypeId,
  });
  const coerced = coerceValueToType({
    value: valueExpr.expr,
    actualType: valueTypeId,
    targetType: targetTypeId,
    ctx,
    fnCtx,
  });

  if (binding.kind === "capture") {
    if (!binding.mutable) {
      throw new Error("cannot assign to immutable capture");
    }
    const envRef = ctx.mod.local.get(binding.envIndex, binding.envSuperType);
    const typedEnv =
      binding.envType === binding.envSuperType
        ? envRef
        : refCast(ctx.mod, envRef, binding.envType);
    return {
      expr: structSetFieldValue({
        mod: ctx.mod,
        fieldIndex: binding.fieldIndex,
        ref: typedEnv,
        value:
          binding.storageType === binding.type
            ? coerced
            : lowerValueForHeapField({
                value: coerced,
                typeId: targetTypeId,
                targetType: binding.storageType,
                ctx,
                fnCtx,
              }),
      }),
      usedReturnCall: false,
    };
  }

  if (binding.kind === "storage-ref") {
    return {
      expr: storeStorageRefBindingValue({
        binding,
        value: coerced,
        ctx,
        fnCtx,
      }),
      usedReturnCall: false,
    };
  }
  if (binding.kind === "projected-element-ref") {
    throw new Error("cannot assign to a projected element binding");
  }

  return {
    expr: storeLocalValue({ binding, value: coerced, ctx, fnCtx }),
    usedReturnCall: false,
  };
};
