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

const countContinuationCalls = ({
  exprId,
  targetSymbol,
  ctx,
}: {
  exprId: HirExprId;
  targetSymbol: SymbolId;
  ctx: TypingContext;
}): number => {
  let count = 0;

  const visitExpression = (id: HirExprId): void => {
    const expr = ctx.hir.expressions.get(id);
    if (!expr) {
      throw new Error(`missing HirExpression ${id}`);
    }

    switch (expr.exprKind) {
      case "identifier":
      case "literal":
      case "overload-set":
      case "continue":
        return;
      case "break":
        if (typeof expr.value === "number") {
          visitExpression(expr.value);
        }
        return;
      case "call": {
        const callee = ctx.hir.expressions.get(expr.callee);
        if (callee?.exprKind === "identifier" && callee.symbol === targetSymbol) {
          count += 1;
        } else {
          visitExpression(expr.callee);
        }
        expr.args.forEach((arg) => visitExpression(arg.expr));
        return;
      }
      case "block":
        expr.statements.forEach(visitStatement);
        if (typeof expr.value === "number") {
          visitExpression(expr.value);
        }
        return;
      case "tuple":
        expr.elements.forEach((entry) => visitExpression(entry));
        return;
      case "loop":
        visitExpression(expr.body);
        return;
      case "while":
        visitExpression(expr.condition);
        visitExpression(expr.body);
        return;
      case "cond":
      case "if":
        expr.branches.forEach((branch) => {
          visitExpression(branch.condition);
          visitExpression(branch.value);
        });
        if (typeof expr.defaultBranch === "number") {
          visitExpression(expr.defaultBranch);
        }
        return;
      case "match":
        visitExpression(expr.discriminant);
        expr.arms.forEach((arm) => {
          if (typeof arm.guard === "number") {
            visitExpression(arm.guard);
          }
          visitExpression(arm.value);
        });
        return;
      case "effect-handler":
        visitExpression(expr.body);
        expr.handlers.forEach((handler) => visitExpression(handler.body));
        if (typeof expr.finallyBranch === "number") {
          visitExpression(expr.finallyBranch);
        }
        return;
      case "object-literal":
        expr.entries.forEach((entry) => visitExpression(entry.value));
        return;
      case "field-access":
        visitExpression(expr.target);
        return;
      case "assign":
        if (typeof expr.target === "number") {
          visitExpression(expr.target);
        }
        visitExpression(expr.value);
        return;
      case "lambda":
        visitExpression(expr.body);
        return;
    }
  };

  const visitStatement = (id: number): void => {
    const stmt = ctx.hir.statements.get(id);
    if (!stmt) {
      throw new Error(`missing HirStatement ${id}`);
    }
    switch (stmt.kind) {
      case "let":
        visitExpression(stmt.initializer);
        return;
      case "expr-stmt":
        visitExpression(stmt.expr);
        return;
      case "return":
        if (typeof stmt.value === "number") {
          visitExpression(stmt.value);
        }
        return;
    }
  };

  visitExpression(exprId);
  return count;
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
  const resumeCount =
    typeof continuationSymbol === "number"
      ? countContinuationCalls({
          exprId: clause.body,
          targetSymbol: continuationSymbol,
          ctx,
        })
      : 0;
  if (resumeCount !== 1) {
    emitDiagnostic({
      ctx,
      code: "TY0015",
      params: {
        kind: "tail-resume-count",
        operation: opName,
        count: resumeCount,
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
  let reRaised = false;

  expr.handlers.forEach((clause) => {
    const opName = effectOpName(clause.operation, ctx);
    const clauseEffectRow = typeHandlerClause({ clause, ctx, state });
    handlerEffects.push(clauseEffectRow);
    const clauseDesc = ctx.effects.getRow(clauseEffectRow);
    const reRaises = clauseDesc.operations.some((op) => op.name === opName);
    reRaised = reRaised || reRaises;
    if (!reRaises) {
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
  if (!reRaised && remainingDesc.operations.length > 0 && !remainingDesc.tailVar) {
    const opList = remainingDesc.operations.map((op) => op.name).join(", ");
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
