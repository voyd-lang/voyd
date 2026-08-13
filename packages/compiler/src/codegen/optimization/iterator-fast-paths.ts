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
import { incrementCompilerPerfCounter } from "../../perf.js";
import type { ExactIteratorFallbackReason } from "../../perf-counter-schema.js";

type ExactIteratorTargetDecision =
  | {
      accepted: true;
      target: ProgramSymbolId;
      iteratorTypeId: TypeId;
    }
  | { accepted: false; reason: ExactIteratorFallbackReason };

const recordExactIteratorDecision = (
  decision:
    | { accepted: true }
    | { accepted: false; reason: ExactIteratorFallbackReason },
): void => {
  incrementCompilerPerfCounter("codegen.exact_iterator_for.requested");
  incrementCompilerPerfCounter(
    decision.accepted
      ? "codegen.exact_iterator_for.accepted"
      : `codegen.exact_iterator_for.fallback.${decision.reason}`,
  );
};

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
    whileExpr?.exprKind !== "while"
  ) {
    return undefined;
  }
  if (
    !isCanonicalStdTraitMethodCall({
      expr: iterCall,
      traitName: "Sequence",
      methodName: "iter",
      allowExternalImplementations: true,
      ctx,
    })
  ) {
    recordExactIteratorDecision({
      accepted: false,
      reason: "noncanonical-iter-call",
    });
    return undefined;
  }
  const body = parseCanonicalStdForBody({
    whileExpr,
    iteratorSymbol: iteratorStmt.pattern.symbol,
    allowExternalImplementations: true,
    ctx,
  });
  if (!body) {
    recordExactIteratorDecision({
      accepted: false,
      reason: "noncanonical-body",
    });
    return undefined;
  }
  const exactNext = exactIteratorNextTargetFor({
    iterCall,
    nextCall: body.nextCall,
    ctx,
    fnCtx,
  });
  recordExactIteratorDecision(exactNext);
  if (!exactNext.accepted) {
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
}): ExactIteratorTargetDecision => {
  if (!exactNominalExpressionType({ exprId: iterCall.target, ctx, fnCtx })) {
    return { accepted: false, reason: "nonexact-receiver" };
  }
  const iterTarget = callTargetForContext({ callId: iterCall.id, ctx, fnCtx });
  if (typeof iterTarget !== "number") {
    return { accepted: false, reason: "unresolved-iter-target" };
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
    return { accepted: false, reason: "missing-iter-metadata" };
  }
  const targetCtx = ctx.moduleContexts.get(iterRef.moduleId);
  const iterItem = targetCtx
    ? [...targetCtx.module.hir.items.values()].find(
        (item) => item.kind === "function" && item.symbol === iterRef.symbol,
      )
    : undefined;
  if (!targetCtx || iterItem?.kind !== "function") {
    return { accepted: false, reason: "missing-iter-body" };
  }
  const iteratorTypeId = freshExactNominalResultType({
    exprId: iterItem.body,
    ctx: targetCtx,
    instanceId: iterMeta.instanceId,
  });
  if (typeof iteratorTypeId !== "number") {
    return { accepted: false, reason: "nonfresh-iterator-result" };
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
    return {
      accepted: false,
      reason:
        typeof selectedNext === "number"
          ? "missing-next-trait-mapping"
          : "unresolved-next-target",
    };
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
    ? { accepted: true, target: unique[0]!, iteratorTypeId }
    : { accepted: false, reason: "ambiguous-next-implementation" };
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
