import binaryen from "binaryen";
import type {
  CodegenContext,
  ExpressionCompiler,
  FunctionContext,
  HirExprId,
  HirPattern,
  TypeId,
} from "./context.js";
import {
  allocateTempLocal,
  declareLocal,
  declareLocalWithTypeId,
  getRequiredBinding,
  loadLocalValue,
  storeStorageRefBindingValue,
  storeLocalValue,
} from "./locals.js";
import {
  coerceValueToType,
  loadStructuralField,
} from "./structural.js";
import {
  getDeclaredSymbolTypeId,
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
  temp: ReturnType<typeof allocateTempLocal>;
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

export const compilePatternInitialization = ({
  pattern,
  initializer,
  ctx,
  fnCtx,
  ops,
  compileExpr,
  options,
}: PatternInitParams): void => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
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
        compileExpr({ exprId: initializer, ctx, fnCtx }).expr,
        fnCtx,
      )
    );
    return;
  }

  if (pattern.kind !== "identifier") {
    throw new Error(`unsupported pattern kind ${pattern.kind}`);
  }

  const initializerType = getRequiredExprType(
    initializer,
    ctx,
    typeInstanceId
  );
  const targetTypeId = options.declare
    ? getDeclaredSymbolTypeId(pattern.symbol, ctx, typeInstanceId)
    : getSymbolTypeId(pattern.symbol, ctx, typeInstanceId);
  const binding = options.declare
    ? declareLocalWithTypeId(pattern.symbol, targetTypeId, ctx, fnCtx)
    : getRequiredBinding(pattern.symbol, ctx, fnCtx);
  const value = compileExpr({
    exprId: initializer,
    ctx,
    fnCtx,
    expectedResultTypeId:
      initializerType === targetTypeId ? targetTypeId : undefined,
  });

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
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  if (pattern.kind === "wildcard") {
    return;
  }

  if (pattern.kind === "identifier") {
    const targetTypeId = options.declare
      ? getDeclaredSymbolTypeId(pattern.symbol, ctx, typeInstanceId)
      : getSymbolTypeId(pattern.symbol, ctx, typeInstanceId);
    const binding = options.declare
      ? declareLocalWithTypeId(pattern.symbol, targetTypeId, ctx, fnCtx)
      : getRequiredBinding(pattern.symbol, ctx, fnCtx);
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

  const initializerTemp = allocateTempLocal(
    wasmTypeFor(valueTypeId, ctx),
    fnCtx,
    valueTypeId,
    ctx,
  );
  ops.push(
    storeLocalValue({
      binding: initializerTemp,
      value: coerceValueToType({
        value,
        actualType: valueTypeId,
        targetType: valueTypeId,
        ctx,
        fnCtx,
      }),
      ctx,
      fnCtx,
    }),
  );

  const pending = collectAssignmentsFromValue({
    pattern,
    temp: initializerTemp,
    typeId: valueTypeId,
    ctx,
    fnCtx,
    ops,
  });

  pending.forEach(({ pattern: subPattern, temp, typeId }) => {
    const targetTypeId = typeId;
    const binding = options.declare
      ? declareLocalWithTypeId(subPattern.symbol, targetTypeId, ctx, fnCtx)
      : getRequiredBinding(subPattern.symbol, ctx, fnCtx);
    ops.push(
      storeIntoBinding({
        binding,
        value: loadLocalValue(temp, ctx),
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
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const initializerType = getRequiredExprType(
    initializer,
    ctx,
    typeInstanceId
  );
  const initializerTemp = allocateTempLocal(
    wasmTypeFor(initializerType, ctx),
    fnCtx,
    initializerType,
    ctx,
  );
  const compiled = compileExpr({
    exprId: initializer,
    ctx,
    fnCtx,
    expectedResultTypeId: initializerType,
  }).expr;
  ops.push(
    storeLocalValue({
      binding: initializerTemp,
      value: coerceValueToType({
        value: compiled,
        actualType: initializerType,
        targetType: initializerType,
        ctx,
        fnCtx,
      }),
      ctx,
      fnCtx,
    }),
  );

  const pending = collectAssignmentsFromValue({
    pattern,
    temp: initializerTemp,
    typeId: initializerType,
    ctx,
    fnCtx,
    ops,
  });
  pending.forEach(({ pattern: subPattern, temp, typeId }) => {
    const targetTypeId = typeId;
    const binding = options.declare
      ? declareLocalWithTypeId(subPattern.symbol, targetTypeId, ctx, fnCtx)
      : getRequiredBinding(subPattern.symbol, ctx, fnCtx);
    ops.push(
      storeIntoBinding({
        binding,
        value: loadLocalValue(temp, ctx),
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
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const initializerType = getRequiredExprType(
    initializer,
    ctx,
    typeInstanceId
  );
  const initializerTemp = allocateTempLocal(
    wasmTypeFor(initializerType, ctx),
    fnCtx,
    initializerType,
    ctx,
  );
  const compiled = compileExpr({
    exprId: initializer,
    ctx,
    fnCtx,
    expectedResultTypeId: initializerType,
  }).expr;
  ops.push(
    storeLocalValue({
      binding: initializerTemp,
      value: coerceValueToType({
        value: compiled,
        actualType: initializerType,
        targetType: initializerType,
        ctx,
        fnCtx,
      }),
      ctx,
      fnCtx,
    }),
  );

  const pending = collectAssignmentsFromValue({
    pattern,
    temp: initializerTemp,
    typeId: initializerType,
    ctx,
    fnCtx,
    ops,
  });
  pending.forEach(({ pattern: subPattern, temp, typeId }) => {
    const targetTypeId = typeId;
    const binding = options.declare
      ? declareLocalWithTypeId(subPattern.symbol, targetTypeId, ctx, fnCtx)
      : getRequiredBinding(subPattern.symbol, ctx, fnCtx);
    ops.push(
      storeIntoBinding({
        binding,
        value: loadLocalValue(temp, ctx),
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
  temp: ReturnType<typeof allocateTempLocal>;
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
    const collected: PendingPatternAssignment[] = [];
    pattern.elements.forEach((subPattern, index) => {
      const field = structInfo.fieldMap.get(`${index}`);
      if (!field) {
        throw new Error(`tuple is missing element ${index}`);
      }
      const elementTemp = allocateTempLocal(field.wasmType, fnCtx, field.typeId, ctx);
      const load = loadStructuralField({
        structInfo,
        field,
        pointer: () => loadLocalValue(temp, ctx),
        ctx,
      });
      ops.push(storeLocalValue({ binding: elementTemp, value: load, ctx, fnCtx }));
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
    const collected: PendingPatternAssignment[] = [];
    pattern.fields.forEach(({ name, pattern: subPattern }) => {
      const field = structInfo.fieldMap.get(name);
      if (!field) {
        throw new Error(`object is missing field ${name}`);
      }
      const fieldTemp = allocateTempLocal(field.wasmType, fnCtx, field.typeId, ctx);
      const load = loadStructuralField({
        structInfo,
        field,
        pointer: () => loadLocalValue(temp, ctx),
        ctx,
      });
      ops.push(storeLocalValue({ binding: fieldTemp, value: load, ctx, fnCtx }));
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
        temp,
        typeId,
      },
    ];
};
