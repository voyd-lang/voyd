import type { HirExpression } from "../hir/index.js";
import type { HirExprId, TypeId } from "../ids.js";
import {
  typeAssignExpr,
  typeBlockExpr,
  typeCallExpr,
  typeMethodCallExpr,
  formatFunctionInstanceKey,
  typeFieldAccessExpr,
  typeIdentifierExpr,
  typeIfExpr,
  typeLambdaExpr,
  typeLiteralExpr,
  typeMatchExpr,
  typeObjectLiteralExpr,
  typeOverloadSetExpr,
  typeEffectHandlerExpr,
  typeBreakExpr,
  typeContinueExpr,
  typeLoopExpr,
  typeTupleExpr,
  typeWhileExpr,
} from "./expressions/index.js";
import { applyCurrentSubstitution } from "./expressions/shared.js";
import { ensureTypeMatches } from "./type-system.js";
import { emitDiagnostic, normalizeSpan } from "../../diagnostics/index.js";
import type { TypingContext, TypingState } from "./types.js";

export { formatFunctionInstanceKey };

export type TypeExpressionOptions = {
  expectedType?: TypeId;
  /** When true, the expression's resulting value is not used (statement context). */
  discardValue?: boolean;
};

export const typeExpression = (
  exprId: HirExprId,
  ctx: TypingContext,
  state: TypingState,
  options: TypeExpressionOptions = {}
): TypeId => {
  const expectedType = options.expectedType;
  const cached = ctx.table.getExprType(exprId);
  if (typeof cached === "number") {
    if (ctx.effects.getExprEffect(exprId) === undefined) {
      ctx.effects.setExprEffect(exprId, ctx.effects.emptyRow);
    }
    const applied = applyCurrentSubstitution(cached, ctx, state);
    const appliedExpected =
      typeof expectedType === "number"
        ? applyCurrentSubstitution(expectedType, ctx, state)
        : undefined;
    if (
      typeof appliedExpected === "number" &&
      appliedExpected !== ctx.primitives.unknown
    ) {
      try {
        ensureTypeMatches(
          applied,
          appliedExpected,
          ctx,
          state,
          "expression context"
        );
      } catch (error) {
        const span = normalizeSpan(ctx.hir.expressions.get(exprId)?.span);
        emitDiagnostic({
          ctx,
          code: "TY9999",
          params: {
            kind: "unexpected-error",
            message: error instanceof Error ? error.message : String(error),
          },
          span,
        });
      }
    }
    ctx.resolvedExprTypes.set(exprId, applied);
    return applied;
  }

  const expr = ctx.hir.expressions.get(exprId);
  if (!expr) {
    throw new Error(`missing HirExpression ${exprId}`);
  }

  const type = resolveExpressionType(expr, ctx, state, options);
  const appliedType = applyCurrentSubstitution(type, ctx, state);
  ctx.table.setExprType(exprId, type);
  ctx.resolvedExprTypes.set(exprId, appliedType);
  if (ctx.effects.getExprEffect(exprId) === undefined) {
    ctx.effects.setExprEffect(exprId, ctx.effects.emptyRow);
  }
  return appliedType;
};

const resolveExpressionType = (
  expr: HirExpression,
  ctx: TypingContext,
  state: TypingState,
  options: TypeExpressionOptions
): TypeId => {
  const expectedType = options.expectedType;
  switch (expr.exprKind) {
    case "literal":
      return typeLiteralExpr(expr, ctx);
    case "identifier":
      return typeIdentifierExpr(expr, ctx);
    case "overload-set":
      return typeOverloadSetExpr(expr, ctx);
    case "call":
      return typeCallExpr(expr, ctx, state, expectedType);
    case "method-call":
      return typeMethodCallExpr(expr, ctx, state, expectedType);
    case "block":
      return typeBlockExpr(expr, ctx, state, options);
    case "if":
      return typeIfExpr(expr, ctx, state, options);
    case "match":
      return typeMatchExpr(expr, ctx, state, options);
    case "effect-handler":
      return typeEffectHandlerExpr(expr, ctx, state, expectedType);
    case "tuple":
      return typeTupleExpr(expr, ctx, state);
    case "object-literal":
      return typeObjectLiteralExpr(expr, ctx, state);
    case "field-access":
      return typeFieldAccessExpr(expr, ctx, state);
    case "while":
      return typeWhileExpr(expr, ctx, state);
    case "loop":
      return typeLoopExpr(expr, ctx, state);
    case "assign":
      return typeAssignExpr(expr, ctx, state);
    case "break":
      return typeBreakExpr(expr, ctx, state);
    case "continue":
      return typeContinueExpr(expr, ctx);
    case "lambda":
      return typeLambdaExpr(expr, ctx, state, expectedType);
    default:
      throw new Error(`unsupported expression kind: ${expr.exprKind}`);
  }
};
