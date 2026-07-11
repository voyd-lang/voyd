import binaryen from "binaryen";
import type {
  CodegenContext,
  ExpressionCompiler,
  FunctionContext,
  HirExprId,
  HirBlockExpr,
  HirCondExpr,
  HirObjectLiteralExpr,
  HirExpression,
  HirIfExpr,
  LocalBindingScalarAggregate,
  StructuralFieldInfo,
  StructuralTypeInfo,
  SymbolId,
  TypeId,
} from "../context.js";
import {
  allocateTempLocal,
  loadLocalValue,
  storeScalarAggregateBindingValue,
  storeLocalValue,
} from "../locals.js";
import { coerceValueToType } from "../structural.js";
import { compileOptionalNoneValue } from "../optionals.js";
import { captureMultivalueLanes } from "../multivalue.js";
import {
  getRequiredExprType,
  getStructuralTypeInfo,
  wasmTypeFor,
} from "../types.js";
import { compileCallArgExpressionsWithTemps } from "../expressions/call/shared.js";
import { incrementCompilerPerfCounter } from "../../perf.js";

const SCALAR_AGGREGATE_MATERIALIZATION_BOUNDARY_REASONS = new Set([
  "assignment",
  "return",
]);

const recordScalarAggregateDecision = (
  kind: "initializer" | "parameter",
  decision: string,
): void =>
  incrementCompilerPerfCounter(`codegen.scalar_aggregate.${kind}.${decision}`);

type ScalarAggregateSuspensionBailout =
  | "initializer_suspends"
  | "live_across_suspension";

const scalarAggregateSuspensionBailout = ({
  symbol,
  initializer,
  ctx,
  fnCtx,
}: {
  symbol: SymbolId;
  initializer?: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): ScalarAggregateSuspensionBailout | undefined => {
  if (
    !fnCtx.effectful ||
    ctx.effectsBackend.scalarAggregates.keepLanesAcrossSuspension
  ) {
    return undefined;
  }
  if (
    typeof initializer === "number" &&
    (fnCtx.continuation?.cfg.sitesByExpr.get(initializer)?.size ?? 0) > 0
  ) {
    return "initializer_suspends";
  }
  return ctx.effectLowering.symbolsLiveAcrossSuspension.has(symbol)
    ? "live_across_suspension"
    : undefined;
};

export type ScalarAggregateStatementCompiler = (
  stmtId: number,
) => binaryen.ExpressionRef;

export type ScalarAggregateBlockInitializerCompiler = (
  expr: HirBlockExpr,
  compileBody: () => binaryen.ExpressionRef[] | undefined,
) => binaryen.ExpressionRef[] | undefined;

const aggregateLaneCount = (structInfo: StructuralTypeInfo): number =>
  structInfo.fields.reduce((count, field) => count + field.inlineArity, 0);

const isSmallScalarAggregate = ({
  structInfo,
  ctx,
}: {
  structInfo: StructuralTypeInfo;
  ctx: CodegenContext;
}): boolean =>
  structInfo.fields.length > 0 &&
  aggregateLaneCount(structInfo) <=
    ctx.specializationPolicy.scalarAggregateLanes;

const symbolIsUsedAsMethodReceiver = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: CodegenContext;
}): boolean =>
  Array.from(ctx.module.hir.expressions.values()).some((expr) => {
    if (expr.exprKind !== "method-call") {
      return false;
    }
    const target = ctx.module.hir.expressions.get(expr.target);
    return target?.exprKind === "identifier" && target.symbol === symbol;
  });

const symbolIsUsedAsCallArgument = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: CodegenContext;
}): boolean =>
  Array.from(ctx.module.hir.expressions.values()).some((expr) => {
    if (expr.exprKind !== "call" && expr.exprKind !== "method-call") {
      return false;
    }
    return expr.args.some((arg) => {
      const argExpr = ctx.module.hir.expressions.get(arg.expr);
      return argExpr?.exprKind === "identifier" && argExpr.symbol === symbol;
    });
  });

const symbolIsCapturedByEffectHandler = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: CodegenContext;
}): boolean =>
  Array.from(
    ctx.optimization?.handlerClauseCaptures.get(ctx.moduleId)?.values() ?? [],
  ).some((byClause) =>
    Array.from(byClause.values()).some((symbols) => symbols.includes(symbol)),
  );

const symbolIsUsedAsMutableAliasInitializer = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: CodegenContext;
}): boolean =>
  Array.from(ctx.module.hir.statements.values()).some((stmt) => {
    if (
      stmt.kind !== "let" ||
      stmt.pattern.kind !== "identifier" ||
      (!stmt.mutable && stmt.pattern.bindingKind !== "mutable-ref")
    ) {
      return false;
    }
    const initializer = ctx.module.hir.expressions.get(stmt.initializer);
    return (
      initializer?.exprKind === "identifier" && initializer.symbol === symbol
    );
  });

const fieldAccessRoot = ({
  exprId,
  ctx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
}): { symbol?: SymbolId; depth: number } => {
  let currentExprId = exprId;
  let depth = 0;
  while (true) {
    const expr = ctx.module.hir.expressions.get(currentExprId);
    if (expr?.exprKind === "field-access") {
      depth += 1;
      currentExprId = expr.target;
      continue;
    }
    return {
      symbol: expr?.exprKind === "identifier" ? expr.symbol : undefined,
      depth,
    };
  }
};

const symbolIsUsedAsNestedFieldAssignmentRoot = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: CodegenContext;
}): boolean =>
  Array.from(ctx.module.hir.expressions.values()).some((expr) => {
    if (expr.exprKind !== "assign" || typeof expr.target !== "number") {
      return false;
    }
    const root = fieldAccessRoot({ exprId: expr.target, ctx });
    return root.symbol === symbol && root.depth > 1;
  });

const heapObjectSymbolNeedsStableIdentity = ({
  symbol,
  ctx,
}: {
  symbol: SymbolId;
  ctx: CodegenContext;
}): boolean => symbolIsUsedAsMutableAliasInitializer({ symbol, ctx });

export const scalarAggregateAbiTypesForType = ({
  typeId,
  ctx,
}: {
  typeId: TypeId;
  ctx: CodegenContext;
}): readonly binaryen.Type[] | undefined => {
  const structInfo = getStructuralTypeInfo(typeId, ctx);
  if (!structInfo || !isSmallScalarAggregate({ structInfo, ctx })) {
    return undefined;
  }
  return structInfo.fields.flatMap((field) => [
    ...binaryen.expandType(field.wasmType),
  ]);
};

const nonEscapingOriginFactAllowsScalarization = ({
  symbol,
  exprId,
  typeId,
  ctx,
}: {
  symbol: SymbolId;
  exprId: HirExprId;
  typeId: TypeId;
  ctx: CodegenContext;
}): boolean => {
  const fact = ctx.optimization?.escapeAnalysis.origins
    .get(ctx.moduleId)
    ?.get(exprId);
  const structInfo = getStructuralTypeInfo(typeId, ctx);
  return Boolean(
    fact &&
    fact.originKind === "aggregate" &&
    fact.typeId === typeId &&
    (!fact.escapes ||
      fact.escapeReasons.every((reason) =>
        reason === "assignment"
          ? structInfo?.layoutKind === "value-object"
          : SCALAR_AGGREGATE_MATERIALIZATION_BOUNDARY_REASONS.has(reason),
      )) &&
    fact.directLocalSymbols.includes(symbol),
  );
};

const nonEscapingParameterFactAllowsScalarization = ({
  symbol,
  fnCtx,
  ctx,
}: {
  symbol: SymbolId;
  fnCtx: FunctionContext;
  ctx: CodegenContext;
}): boolean => {
  if (typeof fnCtx.instanceId !== "number") {
    return false;
  }
  const fact = ctx.optimization?.escapeAnalysis.parameters
    .get(fnCtx.instanceId)
    ?.get(symbol);
  return Boolean(fact && !fact.escapes);
};

const createScalarAggregateBinding = ({
  symbol,
  typeId,
  mutable,
  structInfo,
  ctx,
  fnCtx,
}: {
  symbol?: SymbolId;
  typeId: TypeId;
  mutable: boolean;
  structInfo: StructuralTypeInfo;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): LocalBindingScalarAggregate => {
  const fields = new Map<string, ReturnType<typeof allocateTempLocal>>();
  structInfo.fields.forEach((field) => {
    fields.set(
      field.name,
      allocateTempLocal(field.wasmType, fnCtx, field.typeId, ctx),
    );
  });

  const binding: LocalBindingScalarAggregate = {
    kind: "scalar-aggregate",
    mutable,
    type: wasmTypeFor(typeId, ctx),
    storageType: wasmTypeFor(typeId, ctx),
    typeId,
    structInfo,
    fields,
  };
  if (typeof symbol === "number") {
    fnCtx.bindings.set(symbol, binding);
  }
  return binding;
};

export const createScalarAggregateTempBinding = ({
  typeId,
  structInfo,
  ctx,
  fnCtx,
}: {
  typeId: TypeId;
  structInfo: StructuralTypeInfo;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): LocalBindingScalarAggregate =>
  createScalarAggregateBinding({
    typeId,
    mutable: false,
    structInfo,
    ctx,
    fnCtx,
  });

const storeFieldValue = ({
  binding,
  field,
  value,
  actualTypeId,
  ctx,
  fnCtx,
}: {
  binding: LocalBindingScalarAggregate;
  field: StructuralFieldInfo;
  value: binaryen.ExpressionRef;
  actualTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef => {
  const fieldBinding = binding.fields.get(field.name);
  if (!fieldBinding) {
    throw new Error(`scalar aggregate missing field ${field.name}`);
  }
  return storeLocalValue({
    binding: fieldBinding,
    value: coerceValueToType({
      value,
      actualType: actualTypeId,
      targetType: field.typeId,
      ctx,
      fnCtx,
    }),
    ctx,
    fnCtx,
  });
};

const objectLiteralCanScalarize = (
  expr: HirObjectLiteralExpr,
  structInfo: StructuralTypeInfo,
): boolean => {
  if (expr.entries.some((entry) => entry.kind !== "field")) {
    return false;
  }
  const initialized = new Set(
    expr.entries
      .filter(
        (entry): entry is Extract<typeof entry, { kind: "field" }> =>
          entry.kind === "field",
      )
      .map((entry) => entry.name),
  );
  return structInfo.fields.every(
    (field) => initialized.has(field.name) || field.optional,
  );
};

const compileObjectLiteralIntoScalarBinding = ({
  binding,
  expr,
  structInfo,
  ctx,
  fnCtx,
  compileExpr,
}: {
  binding: LocalBindingScalarAggregate;
  expr: HirObjectLiteralExpr;
  structInfo: StructuralTypeInfo;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): binaryen.ExpressionRef[] => {
  const typeInstanceId = fnCtx.typeInstanceId ?? fnCtx.instanceId;
  const values = compileCallArgExpressionsWithTemps({
    callId: expr.id,
    args: expr.entries.map((entry) => ({ expr: entry.value })),
    expectedTypeIdAt: (index) => {
      const entry = expr.entries[index];
      return entry?.kind === "field"
        ? structInfo.fieldMap.get(entry.name)?.typeId
        : undefined;
    },
    ctx,
    fnCtx,
    compileExpr,
  });
  const ops: binaryen.ExpressionRef[] = [];
  const initialized = new Set<string>();

  expr.entries.forEach((entry, index) => {
    if (entry.kind !== "field") {
      throw new Error(
        "scalar aggregate object literal unexpectedly contains a spread",
      );
    }
    const field = structInfo.fieldMap.get(entry.name);
    if (!field) {
      throw new Error(`object literal cannot set unknown field ${entry.name}`);
    }
    ops.push(
      storeFieldValue({
        binding,
        field,
        value: values[index]!,
        actualTypeId: getRequiredExprType(entry.value, ctx, typeInstanceId),
        ctx,
        fnCtx,
      }),
    );
    initialized.add(entry.name);
  });

  structInfo.fields.forEach((field) => {
    if (initialized.has(field.name)) {
      return;
    }
    if (!field.optional) {
      throw new Error(`missing initializer for field ${field.name}`);
    }
    ops.push(
      storeFieldValue({
        binding,
        field,
        value: compileOptionalNoneValue({
          targetTypeId: field.typeId,
          ctx,
          fnCtx,
        }),
        actualTypeId: field.typeId,
        ctx,
        fnCtx,
      }),
    );
  });

  return ops;
};

const compileTupleIntoScalarBinding = ({
  binding,
  expr,
  structInfo,
  ctx,
  fnCtx,
  compileExpr,
}: {
  binding: LocalBindingScalarAggregate;
  expr: HirExpression & { exprKind: "tuple"; elements: readonly HirExprId[] };
  structInfo: StructuralTypeInfo;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
}): binaryen.ExpressionRef[] => {
  const values = compileCallArgExpressionsWithTemps({
    callId: expr.id,
    args: expr.elements.map((element) => ({ expr: element })),
    expectedTypeIdAt: (index) => structInfo.fieldMap.get(`${index}`)?.typeId,
    ctx,
    fnCtx,
    compileExpr,
  });
  return expr.elements.map((element, index) => {
    const field = structInfo.fieldMap.get(`${index}`);
    if (!field) {
      throw new Error(`tuple element ${index} missing corresponding field`);
    }
    return storeFieldValue({
      binding,
      field,
      value: values[index]!,
      actualTypeId: getRequiredExprType(
        element,
        ctx,
        fnCtx.typeInstanceId ?? fnCtx.instanceId,
      ),
      ctx,
      fnCtx,
    });
  });
};

const exprCanScalarizeAggregateAssignment = ({
  symbol,
  exprId,
  targetTypeId,
  structInfo,
  requireOriginFact,
  allowBlockStatements,
  ctx,
}: {
  symbol?: SymbolId;
  exprId: HirExprId;
  targetTypeId: TypeId;
  structInfo: StructuralTypeInfo;
  requireOriginFact: boolean;
  allowBlockStatements: boolean;
  ctx: CodegenContext;
}): boolean => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr) {
    return false;
  }

  if (expr.exprKind === "object-literal") {
    return (
      (!requireOriginFact ||
        (typeof symbol === "number" &&
          nonEscapingOriginFactAllowsScalarization({
            symbol,
            exprId,
            typeId: targetTypeId,
            ctx,
          }))) &&
      objectLiteralCanScalarize(expr, structInfo)
    );
  }

  if (expr.exprKind === "tuple") {
    return (
      (!requireOriginFact ||
        (typeof symbol === "number" &&
          nonEscapingOriginFactAllowsScalarization({
            symbol,
            exprId,
            typeId: targetTypeId,
            ctx,
          }))) &&
      structInfo.fields.length === expr.elements.length
    );
  }

  if (expr.exprKind === "block") {
    return (
      typeof expr.value === "number" &&
      (expr.statements.length === 0 || allowBlockStatements) &&
      exprCanScalarizeAggregateAssignment({
        symbol,
        exprId: expr.value,
        targetTypeId,
        structInfo,
        requireOriginFact,
        allowBlockStatements,
        ctx,
      })
    );
  }

  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    return (
      typeof expr.defaultBranch === "number" &&
      expr.branches.every((branch) =>
        exprCanScalarizeAggregateAssignment({
          symbol,
          exprId: branch.value,
          targetTypeId,
          structInfo,
          requireOriginFact,
          allowBlockStatements,
          ctx,
        }),
      ) &&
      exprCanScalarizeAggregateAssignment({
        symbol,
        exprId: expr.defaultBranch,
        targetTypeId,
        structInfo,
        requireOriginFact,
        allowBlockStatements,
        ctx,
      })
    );
  }

  if (expr.exprKind === "call" || expr.exprKind === "method-call") {
    return true;
  }

  return false;
};

const scalarAssignmentMayFailAfterBlockStatements = ({
  exprId,
  structInfo,
  ctx,
}: {
  exprId: HirExprId;
  structInfo: StructuralTypeInfo;
  ctx: CodegenContext;
}): boolean => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr) {
    return true;
  }
  if (expr.exprKind === "call" || expr.exprKind === "method-call") {
    return structInfo.layoutKind === "heap-object";
  }
  if (expr.exprKind === "block") {
    return (
      typeof expr.value !== "number" ||
      scalarAssignmentMayFailAfterBlockStatements({
        exprId: expr.value,
        structInfo,
        ctx,
      })
    );
  }
  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    return (
      typeof expr.defaultBranch !== "number" ||
      expr.branches.some((branch) =>
        scalarAssignmentMayFailAfterBlockStatements({
          exprId: branch.value,
          structInfo,
          ctx,
        }),
      ) ||
      scalarAssignmentMayFailAfterBlockStatements({
        exprId: expr.defaultBranch,
        structInfo,
        ctx,
      })
    );
  }
  return false;
};

const asStatementBlock = (
  ctx: CodegenContext,
  ops: readonly binaryen.ExpressionRef[],
): binaryen.ExpressionRef =>
  ops.length === 0
    ? ctx.mod.nop()
    : ctx.mod.block(null, [...ops], binaryen.none);

const compileConditionalAssignment = ({
  binding,
  expr,
  symbol,
  targetTypeId,
  structInfo,
  ctx,
  fnCtx,
  compileExpr,
  compileStatement,
  compileBlockInitializer,
}: {
  binding: LocalBindingScalarAggregate;
  expr: HirIfExpr | HirCondExpr;
  symbol?: SymbolId;
  targetTypeId: TypeId;
  structInfo: StructuralTypeInfo;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  compileStatement?: ScalarAggregateStatementCompiler;
  compileBlockInitializer?: ScalarAggregateBlockInitializerCompiler;
}): binaryen.ExpressionRef[] | undefined => {
  if (typeof expr.defaultBranch !== "number") {
    throw new Error("scalar aggregate conditional requires a default branch");
  }

  const defaultOps = compileScalarAggregateAssignment({
    binding,
    symbol,
    exprId: expr.defaultBranch,
    targetTypeId,
    structInfo,
    ctx,
    fnCtx,
    compileExpr,
    compileStatement,
    compileBlockInitializer,
  });
  if (!defaultOps) {
    return undefined;
  }
  let fallback = asStatementBlock(ctx, defaultOps);

  for (let index = expr.branches.length - 1; index >= 0; index -= 1) {
    const branch = expr.branches[index]!;
    const condition = compileExpr({
      exprId: branch.condition,
      ctx,
      fnCtx,
    }).expr;
    const thenOps = compileScalarAggregateAssignment({
      binding,
      symbol,
      exprId: branch.value,
      targetTypeId,
      structInfo,
      ctx,
      fnCtx,
      compileExpr,
      compileStatement,
      compileBlockInitializer,
    });
    if (!thenOps) {
      return undefined;
    }
    fallback = ctx.mod.if(condition, asStatementBlock(ctx, thenOps), fallback);
  }

  return [fallback];
};

const compileScalarAggregateAssignment = ({
  binding,
  symbol,
  exprId,
  targetTypeId,
  structInfo,
  ctx,
  fnCtx,
  compileExpr,
  compileStatement,
  compileBlockInitializer,
}: {
  binding: LocalBindingScalarAggregate;
  symbol?: SymbolId;
  exprId: HirExprId;
  targetTypeId: TypeId;
  structInfo: StructuralTypeInfo;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  compileStatement?: ScalarAggregateStatementCompiler;
  compileBlockInitializer?: ScalarAggregateBlockInitializerCompiler;
}): binaryen.ExpressionRef[] | undefined => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr) {
    throw new Error(
      `missing scalar aggregate initializer expression ${exprId}`,
    );
  }

  if (expr.exprKind === "object-literal") {
    return compileObjectLiteralIntoScalarBinding({
      binding,
      expr,
      structInfo,
      ctx,
      fnCtx,
      compileExpr,
    });
  }

  if (expr.exprKind === "tuple") {
    return compileTupleIntoScalarBinding({
      binding,
      expr,
      structInfo,
      ctx,
      fnCtx,
      compileExpr,
    });
  }

  if (expr.exprKind === "block") {
    if (typeof expr.value !== "number") {
      throw new Error("scalar aggregate block initializer requires a value");
    }
    if (
      expr.statements.length > 0 &&
      (!compileStatement || !compileBlockInitializer)
    ) {
      return undefined;
    }
    if (
      expr.statements.length > 0 &&
      scalarAssignmentMayFailAfterBlockStatements({
        exprId: expr.value,
        structInfo,
        ctx,
      })
    ) {
      return undefined;
    }
    const compileBody = () => {
      const statementOps = compileStatement
        ? expr.statements.map(compileStatement)
        : [];
      const valueOps = compileScalarAggregateAssignment({
        binding,
        symbol,
        exprId: expr.value!,
        targetTypeId,
        structInfo,
        ctx,
        fnCtx,
        compileExpr,
        compileStatement,
        compileBlockInitializer,
      });
      return valueOps ? [...statementOps, ...valueOps] : undefined;
    };
    return compileBlockInitializer
      ? compileBlockInitializer(expr, compileBody)
      : compileBody();
  }

  if (expr.exprKind === "if" || expr.exprKind === "cond") {
    return compileConditionalAssignment({
      binding,
      expr,
      symbol,
      targetTypeId,
      structInfo,
      ctx,
      fnCtx,
      compileExpr,
      compileStatement,
      compileBlockInitializer,
    });
  }

  if (expr.exprKind === "call" || expr.exprKind === "method-call") {
    const previousBindings =
      binding.structInfo.layoutKind === "heap-object"
        ? new Map(fnCtx.bindings)
        : undefined;
    const value = compileExpr({
      exprId,
      ctx,
      fnCtx,
      expectedResultTypeId: targetTypeId,
      scalarAggregateResultTypeId: targetTypeId,
    });
    if (value.usedScalarAggregateResult) {
      return storeScalarAggregateBindingAbiValue({
        binding,
        value: value.expr,
        ctx,
        fnCtx,
      });
    }
    if (binding.structInfo.layoutKind === "heap-object") {
      if (previousBindings) {
        fnCtx.bindings = previousBindings;
      }
      return undefined;
    }
    return [
      storeScalarAggregateBindingValue({
        binding,
        value: value.expr,
        ctx,
        fnCtx,
      }),
    ];
  }

  return undefined;
};

export const tryScalarizeAggregateInitializer = ({
  symbol,
  initializer,
  targetTypeId,
  mutable,
  ctx,
  fnCtx,
  compileExpr,
  compileStatement,
  compileBlockInitializer,
}: {
  symbol: SymbolId;
  initializer: HirExprId;
  targetTypeId: TypeId;
  mutable: boolean;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  compileStatement?: ScalarAggregateStatementCompiler;
  compileBlockInitializer?: ScalarAggregateBlockInitializerCompiler;
}): binaryen.ExpressionRef[] | undefined => {
  const structInfo = getStructuralTypeInfo(targetTypeId, ctx);
  if (!structInfo) {
    recordScalarAggregateDecision("initializer", "bailout.no_layout");
    return undefined;
  }
  if (!isSmallScalarAggregate({ structInfo, ctx })) {
    recordScalarAggregateDecision("initializer", "bailout.too_wide");
    return undefined;
  }
  if (
    mutable &&
    (symbolIsUsedAsMethodReceiver({ symbol, ctx }) ||
      symbolIsUsedAsCallArgument({ symbol, ctx }))
  ) {
    recordScalarAggregateDecision("initializer", "bailout.mutable_dynamic_use");
    return undefined;
  }
  if (
    structInfo.layoutKind === "heap-object" &&
    heapObjectSymbolNeedsStableIdentity({ symbol, ctx })
  ) {
    recordScalarAggregateDecision("initializer", "bailout.identity_observable");
    return undefined;
  }
  if (symbolIsUsedAsNestedFieldAssignmentRoot({ symbol, ctx })) {
    recordScalarAggregateDecision("initializer", "bailout.nested_assignment");
    return undefined;
  }
  if (symbolIsCapturedByEffectHandler({ symbol, ctx })) {
    recordScalarAggregateDecision("initializer", "bailout.handler_capture");
    return undefined;
  }

  if (
    !exprCanScalarizeAggregateAssignment({
      symbol,
      structInfo,
      exprId: initializer,
      targetTypeId,
      requireOriginFact: true,
      allowBlockStatements: Boolean(
        compileStatement && compileBlockInitializer,
      ),
      ctx,
    })
  ) {
    recordScalarAggregateDecision("initializer", "bailout.escape_or_shape");
    return undefined;
  }

  const suspensionBailout = scalarAggregateSuspensionBailout({
    symbol,
    initializer,
    ctx,
    fnCtx,
  });
  if (suspensionBailout) {
    recordScalarAggregateDecision(
      "initializer",
      `bailout.${suspensionBailout}`,
    );
    return undefined;
  }

  const previousBinding = fnCtx.bindings.get(symbol);
  const binding = createScalarAggregateBinding({
    symbol,
    typeId: targetTypeId,
    mutable,
    structInfo,
    ctx,
    fnCtx,
  });
  const ops = compileScalarAggregateAssignment({
    binding,
    symbol,
    exprId: initializer,
    targetTypeId,
    structInfo,
    ctx,
    fnCtx,
    compileExpr,
    compileStatement,
    compileBlockInitializer,
  });
  if (!ops) {
    if (previousBinding) {
      fnCtx.bindings.set(symbol, previousBinding);
    } else {
      fnCtx.bindings.delete(symbol);
    }
    recordScalarAggregateDecision("initializer", "bailout.lowering_fallback");
    return undefined;
  }
  recordScalarAggregateDecision("initializer", "applied");
  return ops;
};

export const canStoreScalarAggregateExpression = ({
  exprId,
  targetTypeId,
  structInfo,
  allowBlockStatements = false,
  ctx,
}: {
  exprId: HirExprId;
  targetTypeId: TypeId;
  structInfo: StructuralTypeInfo;
  allowBlockStatements?: boolean;
  ctx: CodegenContext;
}): boolean =>
  exprCanScalarizeAggregateAssignment({
    exprId,
    targetTypeId,
    structInfo,
    requireOriginFact: false,
    allowBlockStatements,
    ctx,
  });

export const tryStoreScalarAggregateExpression = ({
  binding,
  exprId,
  targetTypeId,
  ctx,
  fnCtx,
  compileExpr,
  compileStatement,
  compileBlockInitializer,
}: {
  binding: LocalBindingScalarAggregate;
  exprId: HirExprId;
  targetTypeId: TypeId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compileExpr: ExpressionCompiler;
  compileStatement?: ScalarAggregateStatementCompiler;
  compileBlockInitializer?: ScalarAggregateBlockInitializerCompiler;
}): binaryen.ExpressionRef[] | undefined => {
  const structInfo = binding.structInfo;
  if (
    binding.typeId !== targetTypeId ||
    !exprCanScalarizeAggregateAssignment({
      exprId,
      targetTypeId,
      structInfo,
      requireOriginFact: false,
      allowBlockStatements: Boolean(
        compileStatement && compileBlockInitializer,
      ),
      ctx,
    })
  ) {
    return undefined;
  }
  return compileScalarAggregateAssignment({
    binding,
    exprId,
    targetTypeId,
    structInfo,
    ctx,
    fnCtx,
    compileExpr,
    compileStatement,
    compileBlockInitializer,
  });
};

export const storeScalarAggregateBindingAbiValue = ({
  binding,
  value,
  ctx,
  fnCtx,
}: {
  binding: LocalBindingScalarAggregate;
  value: binaryen.ExpressionRef;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef[] => {
  const abiTypes = binding.structInfo.fields.flatMap((field) => [
    ...binaryen.expandType(field.wasmType),
  ]);
  const captured = captureMultivalueLanes({
    value,
    abiTypes,
    ctx,
    fnCtx,
  });
  const stores = binding.structInfo.fields.map((field) => {
    const laneValues = captured.lanes.slice(
      field.inlineStart,
      field.inlineStart + field.inlineArity,
    );
    const fieldValue =
      laneValues.length === 1
        ? laneValues[0]!
        : ctx.mod.tuple.make(laneValues as binaryen.ExpressionRef[]);
    return storeFieldValue({
      binding,
      field,
      value: fieldValue,
      actualTypeId: field.typeId,
      ctx,
      fnCtx,
    });
  });
  return [...captured.setup, ...stores];
};

export const loadScalarAggregateBindingAbiValue = ({
  binding,
  ctx,
}: {
  binding: LocalBindingScalarAggregate;
  ctx: CodegenContext;
}): binaryen.ExpressionRef => {
  const lanes = binding.structInfo.fields.flatMap((field) => {
    const fieldBinding = binding.fields.get(field.name);
    if (!fieldBinding) {
      throw new Error(`scalar aggregate missing field ${field.name}`);
    }
    const value = loadLocalValue(fieldBinding, ctx);
    const fieldAbiTypes = [...binaryen.expandType(field.wasmType)];
    return fieldAbiTypes.length <= 1
      ? [value]
      : fieldAbiTypes.map((_, index) => ctx.mod.tuple.extract(value, index));
  });
  return lanes.length === 1
    ? lanes[0]!
    : ctx.mod.tuple.make(lanes as binaryen.ExpressionRef[]);
};

export const tryBindScalarAggregateParameter = ({
  symbol,
  typeId,
  mutable,
  abiValues,
  scalarAggregateAbi,
  ctx,
  fnCtx,
}: {
  symbol: SymbolId;
  typeId: TypeId;
  mutable: boolean;
  abiValues: readonly binaryen.ExpressionRef[];
  scalarAggregateAbi?: boolean;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): binaryen.ExpressionRef[] | undefined => {
  if (mutable) {
    recordScalarAggregateDecision("parameter", "bailout.mutable");
    return undefined;
  }
  if (!nonEscapingParameterFactAllowsScalarization({ symbol, fnCtx, ctx })) {
    recordScalarAggregateDecision("parameter", "bailout.escapes");
    return undefined;
  }
  const structInfo = getStructuralTypeInfo(typeId, ctx);
  if (!structInfo) {
    recordScalarAggregateDecision("parameter", "bailout.no_layout");
    return undefined;
  }
  if (structInfo.layoutKind !== "value-object" && scalarAggregateAbi !== true) {
    recordScalarAggregateDecision("parameter", "bailout.incompatible_abi");
    return undefined;
  }
  if (!isSmallScalarAggregate({ structInfo, ctx })) {
    recordScalarAggregateDecision("parameter", "bailout.too_wide");
    return undefined;
  }
  if (abiValues.length !== aggregateLaneCount(structInfo)) {
    recordScalarAggregateDecision("parameter", "bailout.lane_mismatch");
    return undefined;
  }

  const suspensionBailout = scalarAggregateSuspensionBailout({
    symbol,
    ctx,
    fnCtx,
  });
  if (suspensionBailout) {
    recordScalarAggregateDecision("parameter", `bailout.${suspensionBailout}`);
    return undefined;
  }

  const binding = createScalarAggregateBinding({
    symbol,
    typeId,
    mutable: false,
    structInfo,
    ctx,
    fnCtx,
  });
  recordScalarAggregateDecision("parameter", "applied");
  return structInfo.fields.map((field) => {
    const laneValues = abiValues.slice(
      field.inlineStart,
      field.inlineStart + field.inlineArity,
    );
    const value =
      laneValues.length === 1
        ? laneValues[0]!
        : ctx.mod.tuple.make(laneValues as binaryen.ExpressionRef[]);
    return storeFieldValue({
      binding,
      field,
      value,
      actualTypeId: field.typeId,
      ctx,
      fnCtx,
    });
  });
};
