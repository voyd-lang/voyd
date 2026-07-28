import binaryen from "binaryen";
import type {
  CodegenContext,
  ExpressionCompiler,
  FunctionContext,
  HirExprId,
  HirPattern,
  LocalBindingScalarAggregate,
  TypeId,
} from "./context.js";
import {
  allocateTempLocal,
  declareLocal,
  declareLocalWithTypeId,
  declareMutableLocalWithTypeId,
  getRequiredBinding,
  loadBindingValue,
  loadBindingStorageRef,
  loadLocalValue,
  loadScalarAggregateBindingField,
  materializeOwnedBinding,
  storeProjectedElementBindingValue,
  storeProjectedFieldBindingValue,
  storeScalarAggregateBindingValue,
  storeStorageRefBindingValue,
  storeLocalValue,
} from "./locals.js";
import {
  coerceValueToType,
  loadStructuralField,
} from "./structural.js";
import {
  getDeclaredSymbolTypeId,
  getMutableRefStorageType,
  getRequiredExprType,
  getStructuralTypeInfo,
  getSymbolTypeId,
  wasmTypeFor,
} from "./types.js";
import { asStatement } from "./expressions/utils.js";
import {
  initDefaultStruct,
  refCast,
  structSetFieldValue,
} from "@voyd-lang/lib/binaryen-gc/index.js";
import {
  tryScalarizeAggregateInitializer,
  type ScalarAggregateBlockInitializerCompiler,
  type ScalarAggregateStatementCompiler,
} from "./optimization/scalar-aggregates.js";

export interface PatternInitOptions {
  declare: boolean;
  mutable?: boolean;
}

interface PatternInitParams {
  pattern: HirPattern;
  initializer: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  ops: binaryen.ExpressionRef[];
  compileExpr: ExpressionCompiler;
  compileStatement?: ScalarAggregateStatementCompiler;
  compileBlockInitializer?: ScalarAggregateBlockInitializerCompiler;
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
    return storeProjectedElementBindingValue({
      binding,
      value: coerced,
      ctx,
      fnCtx,
    });
  }
  if (binding.kind === "projected-field-ref") {
    return storeProjectedFieldBindingValue({
      binding,
      value: coerced,
      valueTypeId: targetTypeId,
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
  return storeLocalValue({ binding, value: coerced, ctx, fnCtx });
};

const canDirectInitializeStorageBackedResult = ({
  initializer,
  targetTypeId,
  initializerType,
  ctx,
}: {
  initializer: HirExprId;
  targetTypeId: TypeId;
  initializerType: TypeId;
  ctx: CodegenContext;
}): boolean => {
  if (initializerType !== targetTypeId) {
    return false;
  }

  const expr = ctx.module.hir.expressions.get(initializer);
  if (!expr) {
    return false;
  }

  switch (expr.exprKind) {
    case "call":
    case "method-call":
    case "object-literal":
    case "tuple":
      return true;
    case "block":
      return (
        typeof expr.value === "number" &&
        canDirectInitializeStorageBackedResult({
          initializer: expr.value,
          targetTypeId,
          initializerType,
          ctx,
        })
      );
    case "if":
      return (
        typeof expr.defaultBranch === "number" &&
        expr.branches.every((branch) =>
          canDirectInitializeStorageBackedResult({
            initializer: branch.value,
            targetTypeId,
            initializerType,
            ctx,
          }),
        ) &&
        canDirectInitializeStorageBackedResult({
          initializer: expr.defaultBranch,
          targetTypeId,
          initializerType,
          ctx,
        })
      );
    case "match":
      return expr.arms.every((arm) =>
        canDirectInitializeStorageBackedResult({
          initializer: arm.value,
          targetTypeId,
          initializerType,
          ctx,
        }),
      );
    default:
      return false;
  }
};

const mutableAliasSourceExpression = ({
  initializer,
  ctx,
}: {
  initializer: HirExprId;
  ctx: CodegenContext;
}): HirExprId | undefined => {
  const expr = ctx.module.hir.expressions.get(initializer);
  if (expr?.exprKind === "identifier" || expr?.exprKind === "field-access") {
    return initializer;
  }
  if (expr?.exprKind !== "call" || expr.args.length !== 1) {
    return undefined;
  }
  const callee = ctx.module.hir.expressions.get(expr.callee);
  if (callee?.exprKind !== "identifier") {
    return undefined;
  }
  const calleeId = ctx.program.symbols.canonicalIdOf(
    ctx.moduleId,
    callee.symbol,
  );
  const intrinsic =
    ctx.program.symbols.getIntrinsicName(calleeId) ??
    ctx.program.symbols.getName(calleeId);
  if (intrinsic !== "~") {
    return undefined;
  }
  const source = ctx.module.hir.expressions.get(expr.args[0]!.expr);
  return source?.exprKind === "identifier" ||
    source?.exprKind === "field-access"
    ? source.id
    : undefined;
};

const projectedFieldPlace = ({
  exprId,
  ctx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
}): { root: number; fields: readonly string[] } | undefined => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (expr?.exprKind !== "field-access") {
    return expr?.exprKind === "identifier"
      ? { root: expr.symbol, fields: [] }
      : undefined;
  }
  const parent = projectedFieldPlace({ exprId: expr.target, ctx });
  return parent
    ? { root: parent.root, fields: [...parent.fields, expr.field] }
    : undefined;
};

const declarePatternLocal = ({
  pattern,
  mutable,
  typeId,
  ctx,
  fnCtx,
}: {
  pattern: Extract<HirPattern, { kind: "identifier" }>;
  mutable: boolean;
  typeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}) =>
  pattern.bindingKind === "mutable-ref" ||
  (mutable && ctx.module.mutableStorageSymbols.has(pattern.symbol))
    ? declareMutableLocalWithTypeId(pattern.symbol, typeId, ctx, fnCtx)
    : declareLocalWithTypeId(pattern.symbol, typeId, ctx, fnCtx);

const getDirectStorageBackedInit = ({
  binding,
  initializer,
  initializerType,
  targetTypeId,
  ctx,
}: {
  binding: ReturnType<typeof getRequiredBinding> | ReturnType<typeof declareLocal>;
  initializer: HirExprId;
  initializerType: TypeId;
  targetTypeId: TypeId;
  ctx: CodegenContext;
}): { setup: binaryen.ExpressionRef[]; storageRef: binaryen.ExpressionRef } | undefined => {
  if (
    !canDirectInitializeStorageBackedResult({
      initializer,
      targetTypeId,
      initializerType,
      ctx,
    })
  ) {
    return undefined;
  }

  const storageRef = loadBindingStorageRef(binding, ctx);
  if (typeof storageRef !== "number") {
    return undefined;
  }

  if (binding.kind !== "local") {
    return { setup: [], storageRef };
  }

  const ensureStorage = ctx.mod.if(
    ctx.mod.ref.is_null(storageRef),
    ctx.mod.local.set(
      binding.index,
      initDefaultStruct(ctx.mod, binding.storageType),
    ),
  );
  return {
    setup: [ensureStorage],
    storageRef: loadBindingStorageRef(binding, ctx)!,
  };
};

export const compilePatternInitialization = ({
  pattern,
  initializer,
  ctx,
  fnCtx,
  ops,
  compileExpr,
  compileStatement,
  compileBlockInitializer,
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
  if (wasmTypeFor(targetTypeId, ctx) === binaryen.none) {
    ops.push(
      asStatement(
        ctx,
        compileExpr({ exprId: initializer, ctx, fnCtx }).expr,
        fnCtx,
      ),
    );
    return;
  }
  const mutableBinding =
    options.mutable === true || pattern.bindingKind === "mutable-ref";
  const aliasSourceExpr =
    options.declare &&
    options.mutable !== true &&
    pattern.bindingKind === "mutable-ref"
      ? mutableAliasSourceExpression({ initializer, ctx })
      : undefined;
  const aliasSource =
    typeof aliasSourceExpr === "number"
      ? ctx.module.hir.expressions.get(aliasSourceExpr)
      : undefined;
  if (aliasSource?.exprKind === "field-access") {
    const place = projectedFieldPlace({ exprId: aliasSource.id, ctx });
    if (place) {
      const source = getRequiredBinding(place.root, ctx, fnCtx);
      const root =
        source.kind === "projected-field-ref" ? source.root : source;
      const rootTypeId =
        source.kind === "projected-field-ref"
          ? source.rootTypeId
          : source.typeId;
      if (
        typeof rootTypeId !== "number" ||
        !loadBindingStorageRef(root, ctx)
      ) {
        throw new Error("mutable field alias root is missing planned storage");
      }
      fnCtx.bindings.set(pattern.symbol, {
        kind: "projected-field-ref",
        root,
        rootTypeId,
        fields:
          source.kind === "projected-field-ref"
            ? [...source.fields, ...place.fields]
            : place.fields,
        type: wasmTypeFor(targetTypeId, ctx),
        storageType: wasmTypeFor(targetTypeId, ctx),
        typeId: targetTypeId,
      });
      return;
    }
  }
  if (aliasSource?.exprKind === "identifier") {
    const sourceBinding = getRequiredBinding(aliasSource.symbol, ctx, fnCtx);
    if (sourceBinding.kind === "projected-field-ref") {
      fnCtx.bindings.set(pattern.symbol, {
        ...sourceBinding,
        type: wasmTypeFor(targetTypeId, ctx),
        storageType: wasmTypeFor(targetTypeId, ctx),
        typeId: targetTypeId,
      });
      return;
    }
    const sourceStorage = loadBindingStorageRef(sourceBinding, ctx);
    const storageType = getMutableRefStorageType({
      typeId: targetTypeId,
      ctx,
    });
    if (typeof storageType === "number") {
      if (!sourceStorage) {
        throw new Error(
          `mutable alias source ${aliasSource.symbol} is missing planned storage`,
        );
      }
      const aliasStorage = allocateTempLocal(storageType, fnCtx);
      fnCtx.bindings.set(pattern.symbol, {
        kind: "storage-ref",
        index: aliasStorage.index,
        type: wasmTypeFor(targetTypeId, ctx),
        storageType,
        typeId: targetTypeId,
        mutable: true,
      });
      ops.push(ctx.mod.local.set(aliasStorage.index, sourceStorage));
      return;
    }
  }
  const scalarized = options.declare
    ? tryScalarizeAggregateInitializer({
        symbol: pattern.symbol,
        initializer,
        targetTypeId,
        mutable: mutableBinding,
        ctx,
        fnCtx,
        compileExpr,
        compileStatement,
        compileBlockInitializer,
      })
    : undefined;
  if (scalarized) {
    ops.push(...scalarized);
    return;
  }

  ops.push(
    ...materializeScalarHeapInitializerAlias({
      initializer,
      ctx,
      fnCtx,
    }),
  );

  const binding = options.declare
    ? declarePatternLocal({
        pattern,
        mutable: options.mutable === true,
        typeId: targetTypeId,
        ctx,
        fnCtx,
      })
    : getRequiredBinding(pattern.symbol, ctx, fnCtx);
  const directStorageBackedInit = getDirectStorageBackedInit({
    binding,
    initializer,
    initializerType,
    targetTypeId,
    ctx,
  });
  const value = compileExpr({
    exprId: initializer,
    ctx,
    fnCtx,
    expectedResultTypeId:
      initializerType === targetTypeId ? targetTypeId : undefined,
    outResultStorageRef: directStorageBackedInit?.storageRef,
  });
  if (value.usedOutResultStorageRef) {
    ops.push(...(directStorageBackedInit?.setup ?? []), value.expr);
    return;
  }

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
      ? declarePatternLocal({
          pattern,
          mutable: options.mutable === true,
          typeId: targetTypeId,
          ctx,
          fnCtx,
        })
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
      ? declarePatternLocal({
          pattern: subPattern,
          mutable: options.mutable === true,
          typeId: targetTypeId,
          ctx,
          fnCtx,
        })
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
  const scalarBinding = getScalarAggregateInitializerBinding({
    initializer,
    ctx,
    fnCtx,
  });
  if (scalarBinding) {
    compilePatternFromScalarAggregate({
      pattern,
      binding: scalarBinding,
      typeId: initializerType,
      ctx,
      fnCtx,
      ops,
      options,
    });
    return;
  }
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
      ? declarePatternLocal({
          pattern: subPattern,
          mutable: options.mutable === true,
          typeId: targetTypeId,
          ctx,
          fnCtx,
        })
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
  const scalarBinding = getScalarAggregateInitializerBinding({
    initializer,
    ctx,
    fnCtx,
  });
  if (scalarBinding) {
    compilePatternFromScalarAggregate({
      pattern,
      binding: scalarBinding,
      typeId: initializerType,
      ctx,
      fnCtx,
      ops,
      options,
    });
    return;
  }
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
      ? declarePatternLocal({
          pattern: subPattern,
          mutable: options.mutable === true,
          typeId: targetTypeId,
          ctx,
          fnCtx,
        })
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

const getScalarAggregateInitializerBinding = ({
  initializer,
  ctx,
  fnCtx,
}: {
  initializer: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): LocalBindingScalarAggregate | undefined => {
  const expr = ctx.module.hir.expressions.get(initializer);
  if (expr?.exprKind !== "identifier") {
    return undefined;
  }
  const binding = fnCtx.bindings.get(expr.symbol);
  return binding?.kind === "scalar-aggregate" ? binding : undefined;
};

const materializeScalarHeapInitializerAlias = ({
  initializer,
  ctx,
  fnCtx,
}: {
  initializer: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): readonly binaryen.ExpressionRef[] => {
  const expr = ctx.module.hir.expressions.get(initializer);
  if (expr?.exprKind !== "identifier") {
    return [];
  }
  const binding = fnCtx.bindings.get(expr.symbol);
  if (
    binding?.kind !== "scalar-aggregate" ||
    binding.structInfo.layoutKind !== "heap-object"
  ) {
    return [];
  }
  return materializeOwnedBinding({
    symbol: expr.symbol,
    ctx,
    fnCtx,
  }).setup;
};

const compilePatternFromScalarAggregate = ({
  pattern,
  binding,
  typeId,
  ctx,
  fnCtx,
  ops,
  options,
}: {
  pattern: HirPattern;
  binding: LocalBindingScalarAggregate;
  typeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  ops: binaryen.ExpressionRef[];
  options: PatternInitOptions;
}): void => {
  const pending = collectAssignmentsFromScalarAggregate({
    pattern,
    binding,
    typeId,
    ctx,
    fnCtx,
    ops,
  });
  pending.forEach(({ pattern: subPattern, temp, typeId: subPatternTypeId }) => {
    const targetTypeId = subPatternTypeId;
    const targetBinding = options.declare
      ? declarePatternLocal({
          pattern: subPattern,
          mutable: options.mutable === true,
          typeId: targetTypeId,
          ctx,
          fnCtx,
        })
      : getRequiredBinding(subPattern.symbol, ctx, fnCtx);
    ops.push(
      storeIntoBinding({
        binding: targetBinding,
        value: loadLocalValue(temp, ctx),
        targetTypeId,
        actualTypeId: subPatternTypeId,
        ctx,
        fnCtx,
      }),
    );
  });
};

const collectAssignmentsFromScalarAggregate = ({
  pattern,
  binding,
  typeId,
  ctx,
  fnCtx,
  ops,
}: {
  pattern: HirPattern;
  binding: LocalBindingScalarAggregate;
  typeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  ops: binaryen.ExpressionRef[];
}): PendingPatternAssignment[] => {
  const structInfo = getStructuralTypeInfo(typeId, ctx);
  if (!structInfo) {
    throw new Error("scalar aggregate pattern requires a structural value");
  }
  const fieldPatterns =
    pattern.kind === "tuple"
      ? pattern.elements.map((subPattern, index) => ({
          name: `${index}`,
          pattern: subPattern,
        }))
      : pattern.kind === "destructure"
        ? pattern.fields
        : undefined;
  if (!fieldPatterns) {
    return collectAssignmentsFromScalarAggregateValue({
      pattern,
      binding,
      typeId,
      ctx,
      fnCtx,
      ops,
    });
  }
  if (pattern.kind === "destructure" && pattern.spread && pattern.spread.kind !== "wildcard") {
    throw new Error("destructure spread bindings are not supported yet");
  }
  if (pattern.kind === "tuple" && fieldPatterns.length !== structInfo.fields.length) {
    throw new Error("tuple pattern arity mismatch");
  }

  return fieldPatterns.flatMap(({ name, pattern: subPattern }) => {
    const field = structInfo.fieldMap.get(name);
    if (!field) {
      throw new Error(`structural value is missing field ${name}`);
    }
    const value = loadScalarAggregateBindingField({
      binding,
      fieldName: name,
      ctx,
    });
    if (typeof value !== "number") {
      throw new Error(`scalar aggregate missing field ${name}`);
    }
    const fieldTemp = allocateTempLocal(field.wasmType, fnCtx, field.typeId, ctx);
    ops.push(
      storeLocalValue({
        binding: fieldTemp,
        value,
        ctx,
        fnCtx,
      }),
    );
    return collectAssignmentsFromValue({
      pattern: subPattern,
      temp: fieldTemp,
      typeId: field.typeId,
      ctx,
      fnCtx,
      ops,
    });
  });
};

const collectAssignmentsFromScalarAggregateValue = ({
  pattern,
  binding,
  typeId,
  ctx,
  fnCtx,
  ops,
}: {
  pattern: HirPattern;
  binding: LocalBindingScalarAggregate;
  typeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  ops: binaryen.ExpressionRef[];
}): PendingPatternAssignment[] => {
  if (pattern.kind === "wildcard") {
    return [];
  }
  if (pattern.kind !== "identifier") {
    throw new Error(`unsupported pattern kind ${pattern.kind}`);
  }
  const temp = allocateTempLocal(wasmTypeFor(typeId, ctx), fnCtx, typeId, ctx);
  ops.push(
    storeLocalValue({
      binding: temp,
      value: loadBindingValue(binding, ctx, fnCtx),
      ctx,
      fnCtx,
    }),
  );
  return [{ pattern, temp, typeId }];
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
