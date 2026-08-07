import type {
  CodegenContext,
  FunctionContext,
  HirBlockExpr,
  HirExprId,
  HirMethodCallExpr,
  TypeId,
} from "../context.js";
import type { ProgramSymbolId } from "../../semantics/ids.js";
import { getRequiredExprType } from "../types.js";
import {
  isCanonicalStdTraitMethodCall,
  parseCanonicalStdForBody,
} from "./array-fast-paths.js";
import { getFunctionMetadataForCall } from "../expressions/call/metadata.js";

export const withExactIteratorForCallTargets = <T>({
  block,
  statementIndex,
  ctx,
  fnCtx,
  compile,
}: {
  block: HirBlockExpr;
  statementIndex: number;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
  compile: () => T;
}): T | undefined => {
  if (!ctx.optimization) {
    return undefined;
  }
  const currentStmt = ctx.module.hir.statements.get(
    block.statements[statementIndex]!,
  );
  const wrapper =
    currentStmt?.kind === "expr-stmt"
      ? ctx.module.hir.expressions.get(currentStmt.expr)
      : undefined;
  const iteratorStmt =
    wrapper?.exprKind === "block" && wrapper.statements.length === 1
      ? ctx.module.hir.statements.get(wrapper.statements[0]!)
      : undefined;
  const iterCall =
    iteratorStmt?.kind === "let"
      ? ctx.module.hir.expressions.get(iteratorStmt.initializer)
      : undefined;
  const whileExpr =
    wrapper?.exprKind === "block" && typeof wrapper.value === "number"
      ? ctx.module.hir.expressions.get(wrapper.value)
      : undefined;
  if (
    iteratorStmt?.kind !== "let" ||
    iteratorStmt.mutable ||
    iteratorStmt.pattern.kind !== "identifier" ||
    iterCall?.exprKind !== "method-call" ||
    !isCanonicalStdTraitMethodCall({
      expr: iterCall,
      traitName: "Sequence",
      methodName: "iter",
      allowExternalImplementations: true,
      ctx,
    }) ||
    whileExpr?.exprKind !== "while"
  ) {
    return undefined;
  }
  const body = parseCanonicalStdForBody({
    whileExpr,
    iteratorSymbol: iteratorStmt.pattern.symbol,
    allowExternalImplementations: true,
    ctx,
  });
  if (!body) {
    return undefined;
  }
  const exactNext = exactIteratorNextTargetFor({
    iterCall,
    nextCall: body.nextCall,
    ctx,
    fnCtx,
  });
  if (!exactNext) {
    return undefined;
  }
  const previousTargets = fnCtx.exactTraitDispatchTargets;
  const previousReceiverTypes = fnCtx.exactCallReceiverTypes;
  fnCtx.exactTraitDispatchTargets = new Map([
    ...(previousTargets?.entries() ?? []),
    [body.nextCall.id, exactNext.target],
  ]);
  fnCtx.exactCallReceiverTypes = new Map([
    ...(previousReceiverTypes?.entries() ?? []),
    [body.nextCall.id, exactNext.iteratorTypeId],
  ]);
  try {
    return compile();
  } finally {
    fnCtx.exactTraitDispatchTargets = previousTargets;
    fnCtx.exactCallReceiverTypes = previousReceiverTypes;
  }
};

const exactIteratorNextTargetFor = ({
  iterCall,
  nextCall,
  ctx,
  fnCtx,
}: {
  iterCall: HirMethodCallExpr;
  nextCall: HirMethodCallExpr;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): { target: ProgramSymbolId; iteratorTypeId: TypeId } | undefined => {
  if (!exactNominalExpressionType({ exprId: iterCall.target, ctx, fnCtx })) {
    return undefined;
  }
  const iterTarget = callTargetForContext({ callId: iterCall.id, ctx, fnCtx });
  if (typeof iterTarget !== "number") {
    return undefined;
  }
  const iterRef = ctx.program.symbols.refOf(iterTarget);
  const iterMeta = getFunctionMetadataForCall({
    symbol: iterRef.symbol,
    moduleId: iterRef.moduleId,
    callId: iterCall.id,
    ctx,
    typeInstanceId: fnCtx.typeInstanceId ?? fnCtx.instanceId,
  });
  if (!iterMeta) {
    return undefined;
  }
  const targetCtx = ctx.moduleContexts.get(iterRef.moduleId);
  const iterItem = targetCtx
    ? [...targetCtx.module.hir.items.values()].find(
        (item) => item.kind === "function" && item.symbol === iterRef.symbol,
      )
    : undefined;
  if (!targetCtx || iterItem?.kind !== "function") {
    return undefined;
  }
  const iteratorTypeId = freshExactNominalResultType({
    exprId: iterItem.body,
    ctx: targetCtx,
    instanceId: iterMeta.instanceId,
  });
  if (typeof iteratorTypeId !== "number") {
    return undefined;
  }

  const selectedNext = callTargetForContext({
    callId: nextCall.id,
    ctx,
    fnCtx,
  });
  const mapping =
    typeof selectedNext === "number"
      ? ctx.program.traits.getTraitMethodImpl(selectedNext)
      : undefined;
  if (!mapping) {
    return undefined;
  }
  const matches = ctx.program.traits
    .getImplsByNominal(iteratorTypeId)
    .filter((impl) => impl.traitSymbol === mapping.traitSymbol)
    .flatMap((impl) =>
      impl.methods
        .filter((method) => method.traitMethod === mapping.traitMethodSymbol)
        .map((method) => method.implMethod),
    );
  const unique = [...new Set(matches)];
  return unique.length === 1
    ? { target: unique[0]!, iteratorTypeId }
    : undefined;
};

const exactNominalExpressionType = ({
  exprId,
  ctx,
  fnCtx,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): TypeId | undefined => {
  const typeId = getRequiredExprType(
    exprId,
    ctx,
    fnCtx.typeInstanceId ?? fnCtx.instanceId,
  );
  const desc = ctx.program.types.getTypeDesc(typeId);
  if (desc.kind === "nominal-object" || desc.kind === "value-object") {
    return typeId;
  }
  return desc.kind === "intersection" ? desc.nominal : undefined;
};

const callTargetForContext = ({
  callId,
  ctx,
  fnCtx,
}: {
  callId: HirExprId;
  ctx: CodegenContext;
  fnCtx: FunctionContext;
}): ProgramSymbolId | undefined => {
  const targets = ctx.program.calls.getCallInfo(ctx.moduleId, callId).targets;
  for (const instanceId of [fnCtx.instanceId, fnCtx.typeInstanceId]) {
    if (typeof instanceId !== "number") {
      continue;
    }
    const target = targets?.get(instanceId);
    if (typeof target === "number") {
      return target;
    }
  }
  return targets?.size === 1 ? targets.values().next().value : undefined;
};

const freshExactNominalResultType = ({
  exprId,
  ctx,
  instanceId,
}: {
  exprId: HirExprId;
  ctx: CodegenContext;
  instanceId: import("../../semantics/ids.js").ProgramFunctionInstanceId;
}): TypeId | undefined => {
  const expr = ctx.module.hir.expressions.get(exprId);
  if (!expr) {
    return undefined;
  }
  if (expr.exprKind === "object-literal") {
    const typeId = getRequiredExprType(exprId, ctx, instanceId);
    const desc = ctx.program.types.getTypeDesc(typeId);
    if (desc.kind === "nominal-object" || desc.kind === "value-object") {
      return typeId;
    }
    return desc.kind === "intersection" ? desc.nominal : undefined;
  }
  if (expr.exprKind === "block") {
    return expr.statements.length === 0 && typeof expr.value === "number"
      ? freshExactNominalResultType({ exprId: expr.value, ctx, instanceId })
      : undefined;
  }
  if (expr.exprKind !== "if" && expr.exprKind !== "cond") {
    return undefined;
  }
  if (typeof expr.defaultBranch !== "number") {
    return undefined;
  }
  const resultTypes = [
    ...expr.branches.map((branch) =>
      freshExactNominalResultType({
        exprId: branch.value,
        ctx,
        instanceId,
      }),
    ),
    freshExactNominalResultType({
      exprId: expr.defaultBranch,
      ctx,
      instanceId,
    }),
  ];
  const first = resultTypes[0];
  return typeof first === "number" &&
    resultTypes.every((type) => type === first)
    ? first
    : undefined;
};
