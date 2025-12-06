import type { HirEffectHandlerExpr } from "../../hir/index.js";
import { typeExpression } from "../expressions.js";
import {
  composeEffectRows,
  effectOpName,
  freshOpenEffectRow,
  getExprEffectRow,
} from "../effects.js";
import { ensureTypeMatches } from "../type-system.js";
import type { TypingContext, TypingState } from "../types.js";
import { emitDiagnostic } from "../../../diagnostics/index.js";
import type { HirExprId, SymbolId, SourceSpan } from "../../ids.js";

const dropHandledOperation = ({
  row,
  opName,
  ctx,
}: {
  row: number;
  opName: string;
  ctx: TypingContext;
}): number => {
  const desc = ctx.effects.getRow(row);
  return ctx.effects.internRow({
    operations: desc.operations.filter((op) => op.name !== opName),
    tailVar: desc.tailVar,
  });
};

const typeHandlerClause = ({
  clause,
  ctx,
  state,
}: {
  clause: HirEffectHandlerExpr["handlers"][number];
  ctx: TypingContext;
  state: TypingState;
}): number => {
  const signature = ctx.functions.getSignature(clause.operation);
  if (!signature) {
    throw new Error(
      `missing effect operation signature for ${effectOpName(
        clause.operation,
        ctx
      )}`
    );
  }

  const continuationParam = clause.parameters[0];
  if (continuationParam) {
    const continuationType = ctx.arena.internFunction({
      parameters: [
        {
          type: signature.returnType,
          optional: false,
        },
      ],
      returnType: signature.returnType,
      effectRow: freshOpenEffectRow(ctx.effects),
    });
    ctx.valueTypes.set(continuationParam.symbol, continuationType);
  }

  clause.parameters.slice(continuationParam ? 1 : 0).forEach((param, index) => {
    const paramType = signature.parameters[index]?.type ?? ctx.primitives.unknown;
    ctx.valueTypes.set(param.symbol, paramType);
  });

  const clauseReturn = typeExpression(
    clause.body,
  ctx,
  state,
  signature.returnType
  );
  if (signature.returnType !== ctx.primitives.unknown) {
    ensureTypeMatches(
      clauseReturn,
      signature.returnType,
      ctx,
      state,
      "handler body"
    );
  }

  return getExprEffectRow(clause.body, ctx);
};

const findEffectOperationDecl = (
  symbol: SymbolId,
  ctx: TypingContext
): { effect: (typeof ctx.decls.effects)[number]; operation: (typeof ctx.decls.effects)[number]["operations"][number] } | undefined => {
  for (const effect of ctx.decls.effects) {
    const operation = effect.operations.find((candidate) => candidate.symbol === symbol);
    if (operation) {
      return { effect, operation };
    }
  }
  return undefined;
};

type ContinuationUsage = { count: number; escapes: boolean };

const mergeUsage = (left: ContinuationUsage, right: ContinuationUsage): ContinuationUsage => ({
  count: left.count + right.count,
  escapes: left.escapes || right.escapes,
});

const analyzeContinuationUsage = ({
  exprId,
  targetSymbol,
  ctx,
  nested,
}: {
  exprId: HirExprId;
  targetSymbol: SymbolId;
  ctx: TypingContext;
  nested?: boolean;
}): ContinuationUsage => {
  const visitExpression = (id: HirExprId, inNestedLambda: boolean): ContinuationUsage => {
    const expr = ctx.hir.expressions.get(id);
    if (!expr) {
      throw new Error(`missing HirExpression ${id}`);
    }

    switch (expr.exprKind) {
      case "identifier":
        return expr.symbol === targetSymbol
          ? { count: 0, escapes: true }
          : { count: 0, escapes: false };
      case "literal":
      case "overload-set":
      case "continue":
        return { count: 0, escapes: false };
      case "break":
        return typeof expr.value === "number"
          ? visitExpression(expr.value, inNestedLambda)
          : { count: 0, escapes: false };
      case "call": {
        const callee = ctx.hir.expressions.get(expr.callee);
        let usage =
          callee?.exprKind === "identifier" && callee.symbol === targetSymbol
            ? { count: 1, escapes: Boolean(inNestedLambda) }
            : visitExpression(expr.callee, inNestedLambda);
        expr.args.forEach((arg) => {
          usage = mergeUsage(usage, visitExpression(arg.expr, inNestedLambda));
        });
        return usage;
      }
      case "block": {
        let usage = expr.statements.reduce(
          (acc, stmtId) => mergeUsage(acc, visitStatement(stmtId, inNestedLambda)),
          { count: 0, escapes: false }
        );
        if (typeof expr.value === "number") {
          usage = mergeUsage(usage, visitExpression(expr.value, inNestedLambda));
        }
        return usage;
      }
      case "tuple":
        return expr.elements.reduce(
          (acc, entry) => mergeUsage(acc, visitExpression(entry, inNestedLambda)),
          { count: 0, escapes: false }
        );
      case "loop":
        return visitExpression(expr.body, inNestedLambda);
      case "while":
        return mergeUsage(
          visitExpression(expr.condition, inNestedLambda),
          visitExpression(expr.body, inNestedLambda)
        );
      case "cond":
      case "if": {
        let usage =
          typeof expr.defaultBranch === "number"
            ? visitExpression(expr.defaultBranch, inNestedLambda)
            : { count: 0, escapes: false };
        expr.branches.forEach((branch) => {
          usage = mergeUsage(
            usage,
            mergeUsage(
              visitExpression(branch.condition, inNestedLambda),
              visitExpression(branch.value, inNestedLambda)
            )
          );
        });
        return usage;
      }
      case "match": {
        let usage = visitExpression(expr.discriminant, inNestedLambda);
        expr.arms.forEach((arm) => {
          if (typeof arm.guard === "number") {
            usage = mergeUsage(usage, visitExpression(arm.guard, inNestedLambda));
          }
          usage = mergeUsage(usage, visitExpression(arm.value, inNestedLambda));
        });
        return usage;
      }
      case "effect-handler": {
        let usage = visitExpression(expr.body, inNestedLambda);
        expr.handlers.forEach((handler) => {
          usage = mergeUsage(usage, visitExpression(handler.body, inNestedLambda));
        });
        if (typeof expr.finallyBranch === "number") {
          usage = mergeUsage(usage, visitExpression(expr.finallyBranch, inNestedLambda));
        }
        return usage;
      }
      case "object-literal":
        return expr.entries.reduce(
          (acc, entry) => mergeUsage(acc, visitExpression(entry.value, inNestedLambda)),
          { count: 0, escapes: false }
        );
      case "field-access":
        return visitExpression(expr.target, inNestedLambda);
      case "assign": {
        const targetUsage =
          typeof expr.target === "number"
            ? visitExpression(expr.target, inNestedLambda)
            : { count: 0, escapes: false };
        return mergeUsage(targetUsage, visitExpression(expr.value, inNestedLambda));
      }
      case "lambda": {
        const inner = visitExpression(expr.body, true);
        return inner.count > 0 || inner.escapes
          ? { count: inner.count, escapes: true }
          : inner;
      }
    }

    return { count: 0, escapes: false };
  };

  const visitStatement = (id: number, inNestedLambda: boolean): ContinuationUsage => {
    const stmt = ctx.hir.statements.get(id);
    if (!stmt) {
      throw new Error(`missing HirStatement ${id}`);
    }
    switch (stmt.kind) {
      case "let":
        return visitExpression(stmt.initializer, inNestedLambda);
      case "expr-stmt":
        return visitExpression(stmt.expr, inNestedLambda);
      case "return":
        return typeof stmt.value === "number"
          ? visitExpression(stmt.value, inNestedLambda)
          : { count: 0, escapes: false };
    }

    return { count: 0, escapes: false };
  };

  return visitExpression(exprId, Boolean(nested));
};

const enforceTailResumption = ({
  clause,
  ctx,
  opName,
  span,
}: {
  clause: HirEffectHandlerExpr["handlers"][number];
  ctx: TypingContext;
  opName: string;
  span: SourceSpan;
}): void => {
  const operationDecl = findEffectOperationDecl(clause.operation, ctx);
  if (operationDecl?.operation.resumable !== "tail") {
    return;
  }
  const continuationSymbol = clause.parameters[0]?.symbol;
  const usage =
    typeof continuationSymbol === "number"
      ? analyzeContinuationUsage({
          exprId: clause.body,
          targetSymbol: continuationSymbol,
          ctx,
        })
      : { count: 0, escapes: false };

  clause.tailResumption = {
    enforcement: usage.escapes ? "runtime" : "static",
    calls: usage.count,
    escapes: usage.escapes,
  };

  const hasStaticViolation =
    usage.count > 1 || (!usage.escapes && usage.count !== 1);
  if (hasStaticViolation) {
    emitDiagnostic({
      ctx,
      code: "TY0015",
      params: {
        kind: "tail-resume-count",
        operation: opName,
        count: usage.count,
      },
      span,
    });
  }
};

export const typeEffectHandlerExpr = (
  expr: HirEffectHandlerExpr,
  ctx: TypingContext,
  state: TypingState
): number => {
  const bodyType = typeExpression(expr.body, ctx, state);
  const bodyEffectRow = getExprEffectRow(expr.body, ctx);

  const handlerEffects: number[] = [];
  let remainingRow = bodyEffectRow;
  const reRaisedOps = new Set<string>();

  expr.handlers.forEach((clause) => {
    const opName = effectOpName(clause.operation, ctx);
    const clauseEffectRow = typeHandlerClause({ clause, ctx, state });
    handlerEffects.push(clauseEffectRow);
    const clauseDesc = ctx.effects.getRow(clauseEffectRow);
    const reRaises = clauseDesc.operations.some((op) => op.name === opName);
    if (reRaises) {
      reRaisedOps.add(opName);
    } else {
      remainingRow = dropHandledOperation({ row: remainingRow, opName, ctx });
    }
    const clauseSpan =
      ctx.hir.expressions.get(clause.body)?.span ?? expr.span;
    enforceTailResumption({ clause, ctx, opName, span: clauseSpan });
  });

  const handlersRow = composeEffectRows(ctx.effects, handlerEffects);
  let effectRow = composeEffectRows(ctx.effects, [remainingRow, handlersRow]);

  if (typeof expr.finallyBranch === "number") {
    const finallyType = typeExpression(expr.finallyBranch, ctx, state, bodyType);
    if (bodyType !== ctx.primitives.unknown) {
      ensureTypeMatches(finallyType, bodyType, ctx, state, "handler finally");
    }
    effectRow = composeEffectRows(ctx.effects, [
      effectRow,
      getExprEffectRow(expr.finallyBranch, ctx),
    ]);
  }

  const remainingDesc = ctx.effects.getRow(remainingRow);
  const unhandled = remainingDesc.operations.filter(
    (op) => !reRaisedOps.has(op.name)
  );
  if (unhandled.length > 0 && !remainingDesc.tailVar) {
    const opList = unhandled.map((op) => op.name).join(", ");
    emitDiagnostic({
      ctx,
      code: "TY0013",
      params: { kind: "unhandled-effects", operations: opList },
      span: expr.span,
    });
  }

  ctx.effects.setExprEffect(expr.id, effectRow);
  return bodyType;
};
