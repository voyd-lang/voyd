import type { BindingResult } from "../binding/binding.js";
import type { SymbolTable } from "../binder/index.js";
import { walkExpression } from "../hir/index.js";
import type {
  HirExpression,
  HirEffectHandlerClause,
  HirEffectHandlerExpr,
  HirGraph,
  HirLambdaExpr,
} from "../hir/index.js";
import type { EffectRowId, HirExprId, SymbolId, TypeId } from "../ids.js";
import type { TypingResult } from "../typing/types.js";

export interface EffectOperationRuntimeInfo {
  symbol: SymbolId;
  effectSymbol: SymbolId;
  localEffectIndex: number;
  opIndex: number;
  resumable: "resume" | "tail";
  name: string;
}

export interface EffectsLoweringFunctionInfo {
  symbol: SymbolId;
  effectRow: EffectRowId;
  pure: boolean;
  hasHandlerInBody: boolean;
  abiEffectful: boolean;
}

export interface EffectsLoweringCallInfo {
  expr: HirExprId;
  callee?: SymbolId;
  effectRow: EffectRowId;
  effectful: boolean;
}

export interface EffectsLoweringHandlerClauseInfo {
  operation: SymbolId;
  effect?: SymbolId;
  resumeKind: "resume" | "tail";
  parameters: HirEffectHandlerClause["parameters"];
  body: HirExprId;
  tailResumption?: HirEffectHandlerClause["tailResumption"];
}

export interface EffectsLoweringHandlerInfo {
  expr: HirEffectHandlerExpr;
  effectRow: EffectRowId;
  clauses: readonly EffectsLoweringHandlerClauseInfo[];
  finallyBranch?: HirExprId;
}

export interface EffectsLoweringLambdaInfo {
  exprId: HirExprId;
  effectfulType: boolean;
  hasHandlerInBody: boolean;
  abiEffectful: boolean;
  shouldLower: boolean;
}

export interface EffectsLoweringInfo {
  operations: Map<SymbolId, EffectOperationRuntimeInfo>;
  functions: Map<SymbolId, EffectsLoweringFunctionInfo>;
  handlers: Map<HirExprId, EffectsLoweringHandlerInfo>;
  calls: Map<HirExprId, EffectsLoweringCallInfo>;
  handlerTails: Map<
    HirEffectHandlerClause["body"],
    HirEffectHandlerClause["tailResumption"]
  >;
  lambdas: Map<HirExprId, EffectsLoweringLambdaInfo>;
}

export interface EffectsLoweringInfoInputs {
  binding: BindingResult;
  symbolTable: SymbolTable;
  hir: HirGraph;
  typing: TypingResult;
}

const isPureEffectRow = (row: EffectRowId, typing: TypingResult): boolean => {
  try {
    return typing.effects.isEmpty(row);
  } catch {
    return false;
  }
};

const exprEffectRow = ({
  expr,
  typing,
}: {
  expr: HirExprId;
  typing: TypingResult;
}): EffectRowId => {
  const fromTable = typing.effects.getExprEffect(expr);
  if (typeof fromTable === "number") {
    return fromTable;
  }
  return typing.effects.emptyRow;
};

const effectNameFor = ({
  operation,
  effect,
  symbolTable,
}: {
  operation: SymbolId;
  effect?: SymbolId;
  symbolTable: SymbolTable;
}): string => {
  const opRecord = symbolTable.getSymbol(operation);
  if (typeof effect === "number") {
    const effectRecord = symbolTable.getSymbol(effect);
    return `${effectRecord.name}.${opRecord.name}`;
  }
  const ownerEffect = (opRecord.metadata as { ownerEffect?: SymbolId } | undefined)
    ?.ownerEffect;
  if (typeof ownerEffect === "number") {
    const effectRecord = symbolTable.getSymbol(ownerEffect);
    return `${effectRecord.name}.${opRecord.name}`;
  }
  return opRecord.name;
};

const callTarget = (expr: HirExpression): SymbolId | undefined =>
  expr.exprKind === "identifier" ? expr.symbol : undefined;

const containsEffectHandler = ({
  rootExprId,
  hir,
  visitLambdaBodies = false,
}: {
  rootExprId: HirExprId;
  hir: HirGraph;
  visitLambdaBodies?: boolean;
}): boolean => {
  let found = false;
  walkExpression({
    exprId: rootExprId,
    hir,
    options: {
      skipLambdas: !visitLambdaBodies,
      skipEffectHandlers: true,
    },
    onEnterExpression: (_exprId, expr) => {
      if (expr.exprKind === "effect-handler") {
        found = true;
      }
    },
  });
  return found;
};

const lambdaEffectfulType = (expr: HirLambdaExpr, typing: TypingResult): boolean => {
  const typeId: TypeId =
    typing.resolvedExprTypes.get(expr.id) ??
    typing.table.getExprType(expr.id) ??
    typing.primitives.unknown;
  const desc = typing.arena.get(typeId);
  if (desc.kind !== "function") return false;
  const effectRow = desc.effectRow;
  return typeof effectRow === "number" && !typing.effects.isEmpty(effectRow);
};

export const buildEffectsLoweringInfo = ({
  binding,
  symbolTable,
  hir,
  typing,
}: EffectsLoweringInfoInputs): EffectsLoweringInfo => {
  const operations = new Map<SymbolId, EffectOperationRuntimeInfo>();
  binding.effects.forEach((effect, localEffectIndex) => {
    effect.operations.forEach((op, opIndex) => {
      operations.set(op.symbol, {
        symbol: op.symbol,
        effectSymbol: effect.symbol,
        localEffectIndex,
        opIndex,
        resumable: op.resumable,
        name: effectNameFor({
          operation: op.symbol,
          effect: effect.symbol,
          symbolTable,
        }),
      });
    });
  });

  const functions = new Map<SymbolId, EffectsLoweringFunctionInfo>();
  hir.items.forEach((item) => {
    if (item.kind !== "function") return;
    const signature = typing.functions.getSignature(item.symbol);
    const effectRow = signature?.effectRow ?? typing.primitives.defaultEffectRow;
    const hasHandlerInBody = containsEffectHandler({
      rootExprId: item.body,
      hir,
      visitLambdaBodies: false,
    });
    const pure = isPureEffectRow(effectRow, typing);
    functions.set(item.symbol, {
      symbol: item.symbol,
      effectRow,
      pure,
      hasHandlerInBody,
      abiEffectful: !pure || hasHandlerInBody,
    });
  });

  const handlerTails = new Map(typing.tailResumptions);

  const handlers = new Map<HirExprId, EffectsLoweringHandlerInfo>();
  hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "effect-handler") return;
    const clauses: EffectsLoweringHandlerClauseInfo[] = expr.handlers.map((clause) => ({
      operation: clause.operation,
      effect: clause.effect,
      resumeKind: clause.resumable === "fn" ? "tail" : "resume",
      parameters: clause.parameters,
      body: clause.body,
      tailResumption: typing.tailResumptions.get(clause.body),
    }));
    handlers.set(expr.id, {
      expr,
      effectRow: exprEffectRow({ expr: expr.id, typing }),
      clauses,
      finallyBranch: expr.finallyBranch,
    });
  });

  const calls = new Map<HirExprId, EffectsLoweringCallInfo>();
  hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "call" && expr.exprKind !== "method-call") return;
    const calleeExpr =
      expr.exprKind === "call"
        ? hir.expressions.get(expr.callee)
        : undefined;
    const effectRow = exprEffectRow({ expr: expr.id, typing });
    calls.set(expr.id, {
      expr: expr.id,
      callee: calleeExpr ? callTarget(calleeExpr) : undefined,
      effectRow,
      effectful: !isPureEffectRow(effectRow, typing),
    });
  });

  const lambdas = new Map<HirExprId, EffectsLoweringLambdaInfo>();
  hir.expressions.forEach((expr) => {
    if (expr.exprKind !== "lambda") return;
    const hasHandlerInBody = containsEffectHandler({
      rootExprId: expr.body,
      hir,
      visitLambdaBodies: false,
    });
    const effectfulType = lambdaEffectfulType(expr, typing);
    const abiEffectful = effectfulType || hasHandlerInBody;
    lambdas.set(expr.id, {
      exprId: expr.id,
      hasHandlerInBody,
      effectfulType,
      abiEffectful,
      shouldLower: abiEffectful,
    });
  });

  return {
    operations,
    functions,
    handlers,
    calls,
    handlerTails,
    lambdas,
  };
};
