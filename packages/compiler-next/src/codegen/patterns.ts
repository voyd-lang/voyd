import binaryen from "binaryen";
import type {
  CodegenContext,
  ExpressionCompiler,
  FunctionContext,
  HirExprId,
  HirPattern,
  TypeId,
} from "./context.js";
import { allocateTempLocal, declareLocal, getRequiredBinding } from "./locals.js";
import {
  coerceValueToType,
  loadStructuralField,
} from "./structural.js";
import {
  getRequiredExprType,
  getStructuralTypeInfo,
  getSymbolTypeId,
  wasmTypeFor,
} from "./types.js";
import { asStatement } from "./expressions/utils.js";
import { refCast, structSetFieldValue } from "@voyd/lib/binaryen-gc/index.js";

export interface PatternInitOptions {
  declare: boolean;
}

interface PatternInitParams {
  pattern: HirPattern;
  initializer: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  ops: binaryen.ExpressionRef[];
  compileExpr: ExpressionCompiler;
  options: PatternInitOptions;
}

interface PendingTupleAssignment {
  pattern: Extract<HirPattern, { kind: "identifier" }>;
  tempIndex: number;
  tempType: binaryen.Type;
  typeId: TypeId;
}

const storeIntoBinding = ({
  binding,
  value,
  targetTypeId,
  actualTypeId,
  ctx,
  fnCtx,
}: {
  binding: ReturnType<typeof getRequiredBinding> | ReturnType<typeof declareLocal>;
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
  return ctx.mod.local.set(binding.index, coerced);
};

export const compilePatternInitialization = ({
  pattern,
  initializer,
  ctx,
  fnCtx,
  ops,
  compileExpr,
  options,
}: PatternInitParams): void => {
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  if (pattern.kind === "tuple") {
    compileTuplePattern({
      pattern,
      initializer,
      ctx,
      fnCtx,
      ops,
      compileExpr,
      options,
    });
    return;
  }

  if (pattern.kind === "wildcard") {
    ops.push(
      asStatement(
        ctx,
        compileExpr({ exprId: initializer, ctx, fnCtx }).expr
      )
    );
    return;
  }

  if (pattern.kind !== "identifier") {
    throw new Error(`unsupported pattern kind ${pattern.kind}`);
  }

  const binding = options.declare
    ? declareLocal(pattern.symbol, ctx, fnCtx)
    : getRequiredBinding(pattern.symbol, ctx, fnCtx);
  const targetTypeId = getSymbolTypeId(pattern.symbol, ctx);
  const initializerType = getRequiredExprType(
    initializer,
    ctx,
    typeInstanceKey
  );
  const value = compileExpr({ exprId: initializer, ctx, fnCtx });

  ops.push(
    storeIntoBinding({
      binding,
      value: value.expr,
      targetTypeId,
      actualTypeId: initializerType,
      ctx,
      fnCtx,
    })
  );
};

const compileTuplePattern = ({
  pattern,
  initializer,
  ctx,
  fnCtx,
  ops,
  compileExpr,
  options,
}: PatternInitParams & { pattern: HirPattern & { kind: "tuple" } }): void => {
  const typeInstanceKey = fnCtx.typeInstanceKey ?? fnCtx.instanceKey;
  const initializerType = getRequiredExprType(
    initializer,
    ctx,
    typeInstanceKey
  );
  const initializerTemp = allocateTempLocal(
    wasmTypeFor(initializerType, ctx),
    fnCtx
  );
  ops.push(
    ctx.mod.local.set(
      initializerTemp.index,
      compileExpr({ exprId: initializer, ctx, fnCtx }).expr
    )
  );

  const pending = collectTupleAssignmentsFromValue({
    pattern,
    temp: initializerTemp,
    typeId: initializerType,
    ctx,
    fnCtx,
    ops,
    compileExpr,
  });
  pending.forEach(({ pattern: subPattern, tempIndex, tempType, typeId }) => {
    const binding = options.declare
      ? declareLocal(subPattern.symbol, ctx, fnCtx)
      : getRequiredBinding(subPattern.symbol, ctx, fnCtx);
    const targetTypeId = getSymbolTypeId(subPattern.symbol, ctx);
    ops.push(
      storeIntoBinding({
        binding,
        value: ctx.mod.local.get(tempIndex, tempType),
        targetTypeId,
        actualTypeId: typeId,
        ctx,
        fnCtx,
      })
    );
  });
};

const collectTupleAssignmentsFromValue = ({
  pattern,
  temp,
  typeId,
  ctx,
  fnCtx,
  ops,
  compileExpr,
}: {
  pattern: HirPattern;
  temp: { index: number; type: binaryen.Type };
  typeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  ops: binaryen.ExpressionRef[];
  compileExpr: ExpressionCompiler;
}): PendingTupleAssignment[] => {
  if (pattern.kind === "tuple") {
    const structInfo = getStructuralTypeInfo(typeId, ctx);
    if (!structInfo) {
      throw new Error("tuple pattern requires a structural tuple value");
    }
    if (pattern.elements.length !== structInfo.fields.length) {
      throw new Error("tuple pattern arity mismatch");
    }
    const pointer = ctx.mod.local.get(temp.index, temp.type);
    const collected: PendingTupleAssignment[] = [];
    pattern.elements.forEach((subPattern, index) => {
      const field = structInfo.fieldMap.get(`${index}`);
      if (!field) {
        throw new Error(`tuple is missing element ${index}`);
      }
      const elementTemp = allocateTempLocal(field.wasmType, fnCtx);
      const load = loadStructuralField({
        structInfo,
        field,
        pointer,
        ctx,
      });
      ops.push(ctx.mod.local.set(elementTemp.index, load));
      collected.push(
        ...collectTupleAssignmentsFromValue({
          pattern: subPattern,
          temp: elementTemp,
          typeId: field.typeId,
          ctx,
          fnCtx,
          ops,
          compileExpr,
        })
      );
    });
    return collected;
  }

  if (pattern.kind === "wildcard") {
    return [];
  }

  if (pattern.kind !== "identifier") {
    throw new Error(`unsupported tuple sub-pattern ${pattern.kind}`);
  }

  return [
    {
      pattern,
      tempIndex: temp.index,
      tempType: temp.type,
      typeId,
    },
  ];
};
