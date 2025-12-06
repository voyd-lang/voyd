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
    const reRaises =
      clauseDesc.operations.some((op) => op.name === opName) ||
      Boolean(clauseDesc.tailVar);
    reRaised = reRaised || reRaises;
    if (!reRaises) {
      remainingRow = dropHandledOperation({ row: remainingRow, opName, ctx });
    }
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
