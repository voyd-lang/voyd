import type {
  EffectMir,
  EffectMirFunction,
  EffectOperationInfo,
  ContinuationBackendOptions,
  EffectMirCall,
  EffectMirHandler,
  EffectMirHandlerClause,
} from "./backend.js";
import type { SemanticsPipelineResult } from "../context.js";
import type {
  EffectRowId,
  HirExprId,
  SymbolId,
} from "../../semantics/ids.js";
import type {
  HirExpression,
  HirEffectHandlerClause,
} from "../../semantics/hir/index.js";

const effectRowFor = (
  symbol: SymbolId,
  semantics: SemanticsPipelineResult
): EffectRowId | undefined =>
  semantics.typing.functions.getSignature(symbol)?.effectRow;

const isPureEffectRow = (
  row: EffectRowId | undefined,
  semantics: SemanticsPipelineResult
): boolean => {
  if (typeof row !== "number") return false;
  try {
    return semantics.typing.effects.isEmpty(row);
  } catch {
    return false;
  }
};

const exprEffectRow = ({
  expr,
  semantics,
}: {
  expr: HirExprId;
  semantics: SemanticsPipelineResult;
}): EffectRowId => {
  const fromTable = semantics.typing.effects.getExprEffect(expr);
  if (typeof fromTable === "number") {
    return fromTable;
  }
  return semantics.typing.effects.emptyRow;
};

const effectNameFor = ({
  operation,
  effect,
  semantics,
}: {
  operation: SymbolId;
  effect?: SymbolId;
  semantics: SemanticsPipelineResult;
}): string => {
  const opRecord = semantics.symbolTable.getSymbol(operation);
  if (typeof effect === "number") {
    const effectRecord = semantics.symbolTable.getSymbol(effect);
    return `${effectRecord.name}.${opRecord.name}`;
  }
  const ownerEffect = (opRecord.metadata as { ownerEffect?: SymbolId } | undefined)
    ?.ownerEffect;
  if (typeof ownerEffect === "number") {
    const effectRecord = semantics.symbolTable.getSymbol(ownerEffect);
    return `${effectRecord.name}.${opRecord.name}`;
  }
  return opRecord.name;
};

const collectOperations = (
  semantics: SemanticsPipelineResult
): Map<SymbolId, EffectOperationInfo> => {
  const operations = new Map<SymbolId, EffectOperationInfo>();
  semantics.binding.decls.effects.forEach((effect) => {
    effect.operations.forEach((op) => {
      operations.set(op.symbol, {
        symbol: op.symbol,
        effect: effect.symbol,
        resumable: op.resumable === "tail" ? "tail" : "resume",
        name: effectNameFor({
          operation: op.symbol,
          effect: effect.symbol,
          semantics,
        }),
      });
    });
  });
  return operations;
};

const collectFunctions = (
  semantics: SemanticsPipelineResult
): Map<SymbolId, EffectMirFunction> => {
  const functions = new Map<SymbolId, EffectMirFunction>();
  semantics.hir.items.forEach((item) => {
    if (item.kind !== "function") return;
    const effectRow =
      effectRowFor(item.symbol, semantics) ??
      semantics.typing.primitives.defaultEffectRow;
    functions.set(item.symbol, {
      symbol: item.symbol,
      effectRow,
      pure: isPureEffectRow(effectRow, semantics),
    });
  });
  return functions;
};

const collectHandlerTails = (
  semantics: SemanticsPipelineResult
): Map<HirEffectHandlerClause["body"], HirEffectHandlerClause["tailResumption"]> =>
  new Map(semantics.typing.tailResumptions);

const handlerResumeKind = (
  clause: HirEffectHandlerClause
): EffectMirHandlerClause["resumeKind"] =>
  clause.resumable === "fn" ? "tail" : "resume";

const collectHandlers = (
  semantics: SemanticsPipelineResult
): Map<HirExprId, EffectMirHandler> => {
  const handlers = new Map<HirExprId, EffectMirHandler>();
  semantics.hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "effect-handler") return;
    const clauses: EffectMirHandlerClause[] = expr.handlers.map((clause) => ({
      operation: clause.operation,
      effect: clause.effect,
      resumeKind: handlerResumeKind(clause),
      parameters: clause.parameters,
      body: clause.body,
      tailResumption: semantics.typing.tailResumptions.get(clause.body),
    }));
    handlers.set(expr.id, {
      expr,
      effectRow: exprEffectRow({ expr: expr.id, semantics }),
      clauses,
      finallyBranch: expr.finallyBranch,
    });
  });
  return handlers;
};

const callTarget = (expr: HirExpression): SymbolId | undefined => {
  if (expr.exprKind === "identifier") {
    return expr.symbol;
  }
  return undefined;
};

const collectCalls = (
  semantics: SemanticsPipelineResult
): Map<HirExprId, EffectMirCall> => {
  const calls = new Map<HirExprId, EffectMirCall>();
  semantics.hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "call") return;
    const calleeExpr = semantics.hir.expressions.get(expr.callee);
    const effectRow = exprEffectRow({ expr: expr.id, semantics });
    calls.set(expr.id, {
      expr: expr.id,
      callee: calleeExpr ? callTarget(calleeExpr) : undefined,
      effectRow,
      effectful: !isPureEffectRow(effectRow, semantics),
    });
  });
  return calls;
};

const stackSwitchFlag = (options?: ContinuationBackendOptions): boolean =>
  options?.stackSwitching ??
  (typeof process !== "undefined" &&
    process.env.VOYD_STACK_SWITCH === "1");

export const buildEffectMir = ({
  semantics,
  options,
}: {
  semantics: SemanticsPipelineResult;
  options?: ContinuationBackendOptions;
}): EffectMir => ({
  functions: collectFunctions(semantics),
  operations: collectOperations(semantics),
  handlers: collectHandlers(semantics),
  calls: collectCalls(semantics),
  handlerTails: collectHandlerTails(semantics),
  semantics,
  stackSwitching: stackSwitchFlag(options),
});
