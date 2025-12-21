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

interface PendingPatternAssignment {
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
  if (pattern.kind === "destructure") {
    compileDestructurePattern({
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

export const compilePatternInitializationFromValue = ({
  pattern,
  value,
  valueTypeId,
  ctx,
  fnCtx,
  ops,
  options,
}: {
  pattern: HirPattern;
  value: binaryen.ExpressionRef;
  valueTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  ops: binaryen.ExpressionRef[];
  options: PatternInitOptions;
}): void => {
  if (pattern.kind === "wildcard") {
    return;
  }

  if (pattern.kind === "identifier") {
    const binding = options.declare
      ? declareLocal(pattern.symbol, ctx, fnCtx)
      : getRequiredBinding(pattern.symbol, ctx, fnCtx);
    const targetTypeId = getSymbolTypeId(pattern.symbol, ctx);
    ops.push(
      storeIntoBinding({
        binding,
        value,
        targetTypeId,
        actualTypeId: valueTypeId,
        ctx,
        fnCtx,
      })
    );
    return;
  }

  if (pattern.kind !== "tuple" && pattern.kind !== "destructure") {
    throw new Error(`unsupported pattern kind ${pattern.kind}`);
  }

  const initializerTemp = allocateTempLocal(wasmTypeFor(valueTypeId, ctx), fnCtx);
  ops.push(ctx.mod.local.set(initializerTemp.index, value));

  const pending = collectAssignmentsFromValue({
    pattern,
    temp: initializerTemp,
    typeId: valueTypeId,
    ctx,
    fnCtx,
    ops,
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

  const pending = collectAssignmentsFromValue({
    pattern,
    temp: initializerTemp,
    typeId: initializerType,
    ctx,
    fnCtx,
    ops,
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

const compileDestructurePattern = ({
  pattern,
  initializer,
  ctx,
  fnCtx,
  ops,
  compileExpr,
  options,
}: PatternInitParams & { pattern: HirPattern & { kind: "destructure" } }): void => {
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

  const pending = collectAssignmentsFromValue({
    pattern,
    temp: initializerTemp,
    typeId: initializerType,
    ctx,
    fnCtx,
    ops,
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

const collectAssignmentsFromValue = ({
  pattern,
  temp,
  typeId,
  ctx,
  fnCtx,
  ops,
}: {
  pattern: HirPattern;
  temp: { index: number; type: binaryen.Type };
  typeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  ops: binaryen.ExpressionRef[];
}): PendingPatternAssignment[] => {
  if (pattern.kind === "tuple") {
    const structInfo = getStructuralTypeInfo(typeId, ctx);
    if (!structInfo) {
      throw new Error("tuple pattern requires a structural tuple value");
    }
    if (pattern.elements.length !== structInfo.fields.length) {
      throw new Error("tuple pattern arity mismatch");
    }
    const pointer = ctx.mod.local.get(temp.index, temp.type);
    const collected: PendingPatternAssignment[] = [];
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
        ...collectAssignmentsFromValue({
          pattern: subPattern,
          temp: elementTemp,
          typeId: field.typeId,
          ctx,
          fnCtx,
          ops,
        })
      );
    });
    return collected;
  }

  if (pattern.kind === "destructure") {
    const structInfo = getStructuralTypeInfo(typeId, ctx);
    if (!structInfo) {
      throw new Error("destructure pattern requires a structural object value");
    }
    if (pattern.spread && pattern.spread.kind !== "wildcard") {
      throw new Error("destructure spread bindings are not supported yet");
    }
    const pointer = ctx.mod.local.get(temp.index, temp.type);
    const collected: PendingPatternAssignment[] = [];
    pattern.fields.forEach(({ name, pattern: subPattern }) => {
      const field = structInfo.fieldMap.get(name);
      if (!field) {
        throw new Error(`object is missing field ${name}`);
      }
      const fieldTemp = allocateTempLocal(field.wasmType, fnCtx);
      const load = loadStructuralField({
        structInfo,
        field,
        pointer,
        ctx,
      });
      ops.push(ctx.mod.local.set(fieldTemp.index, load));
      collected.push(
        ...collectAssignmentsFromValue({
          pattern: subPattern,
          temp: fieldTemp,
          typeId: field.typeId,
          ctx,
          fnCtx,
          ops,
        })
      );
    });
    return collected;
  }

  if (pattern.kind === "wildcard") {
    return [];
  }

  if (pattern.kind !== "identifier") {
    throw new Error(`unsupported pattern kind ${pattern.kind}`);
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
