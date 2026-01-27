import type { HirBlockExpr, HirLetStatement } from "../../hir/index.js";
import type { HirStmtId, TypeId } from "../../ids.js";
import { typeExpression, type TypeExpressionOptions } from "../expressions.js";
import { getExprEffectRow } from "../effects.js";
import {
  bindTuplePatternFromExpr,
  bindTuplePatternFromType,
  bindDestructurePatternFromType,
  recordPatternType,
} from "./patterns.js";
import { mergeBranchType } from "./branching.js";
import {
  ensureTypeMatches,
  resolveTypeExpr,
  typeSatisfies,
  getSymbolName,
} from "../type-system.js";
import { emitDiagnostic } from "../../../diagnostics/index.js";
import type { TypingContext, TypingState } from "../types.js";

export const typeBlockExpr = (
  expr: HirBlockExpr,
  ctx: TypingContext,
  state: TypingState,
  options: TypeExpressionOptions
): TypeId => {
  const expectedType = options.expectedType;
  const discardValue = options.discardValue === true;
  let returnType: TypeId | undefined;
  let effectRow = ctx.effects.emptyRow;

  expr.statements.forEach((stmtId) => {
    const stmtSpan = ctx.hir.statements.get(stmtId)?.span;
    const { type: stmtReturnType, effect: stmtEffect } = typeStatement(
      stmtId,
      ctx,
      state
    );
    effectRow = ctx.effects.compose(effectRow, stmtEffect);
    if (typeof stmtReturnType === "number") {
      returnType = mergeBranchType({
        acc: returnType,
        next: stmtReturnType,
        ctx,
        state,
        span: stmtSpan,
        context: "block",
      });
    }
  });

  if (typeof expr.value === "number") {
    const valueType = typeExpression(expr.value, ctx, state, {
      expectedType,
      discardValue,
    });
    effectRow = ctx.effects.compose(
      effectRow,
      getExprEffectRow(expr.value, ctx)
    );
    ctx.effects.setExprEffect(expr.id, effectRow);
    if (discardValue) {
      return ctx.primitives.void;
    }
    return mergeBranchType({
      acc: returnType,
      next: valueType,
      ctx,
      state,
      span: ctx.hir.expressions.get(expr.value)?.span,
      context: "block",
    });
  }

  ctx.effects.setExprEffect(expr.id, effectRow);
  return returnType ?? ctx.primitives.void;
};

const typeStatement = (
  stmtId: HirStmtId,
  ctx: TypingContext,
  state: TypingState
): { type?: TypeId; effect: number } => {
  const stmt = ctx.hir.statements.get(stmtId);
  if (!stmt) {
    throw new Error(`missing HirStatement ${stmtId}`);
  }

  switch (stmt.kind) {
    case "expr-stmt":
      typeExpression(stmt.expr, ctx, state, { discardValue: true });
      return { effect: getExprEffectRow(stmt.expr, ctx) };
    case "return":
      if (typeof state.currentFunction?.returnType !== "number") {
        throw new Error("return statement outside of function");
      }

      const expectedReturnType = state.currentFunction.returnType;
      const signature =
        typeof state.currentFunction.functionSymbol === "number"
          ? ctx.functions.getSignature(state.currentFunction.functionSymbol)
          : undefined;
      const enforceReturnType = signature?.annotatedReturn === true;
      const functionName =
        typeof state.currentFunction.functionSymbol === "number"
          ? getSymbolName(state.currentFunction.functionSymbol, ctx)
          : undefined;
      if (typeof stmt.value === "number") {
        const valueType = typeExpression(
          stmt.value,
          ctx,
          state,
          { expectedType: expectedReturnType }
        );
        if (
          enforceReturnType &&
          !typeSatisfies(valueType, expectedReturnType, ctx, state)
        ) {
          emitDiagnostic({
            ctx,
            code: "TY0011",
            params: {
              kind: "return-type-mismatch",
              functionName,
            },
            span: stmt.span,
          });
        }
        if (state.currentFunction) {
          state.currentFunction.observedReturnType = mergeBranchType({
            acc: state.currentFunction.observedReturnType,
            next: valueType,
            ctx,
            state,
            span: stmt.span,
            context: "return",
          });
        }
        return { type: valueType, effect: getExprEffectRow(stmt.value, ctx) };
      }

      const voidType = ctx.primitives.void;
      if (
        enforceReturnType &&
        !typeSatisfies(voidType, expectedReturnType, ctx, state)
      ) {
        emitDiagnostic({
          ctx,
          code: "TY0011",
          params: {
            kind: "return-type-mismatch",
            functionName,
          },
          span: stmt.span,
        });
      }
      if (state.currentFunction) {
        state.currentFunction.observedReturnType = mergeBranchType({
          acc: state.currentFunction.observedReturnType,
          next: voidType,
          ctx,
          state,
          span: stmt.span,
          context: "return",
        });
      }
      return { type: voidType, effect: ctx.effects.emptyRow };
    case "let":
      return { effect: typeLetStatement(stmt, ctx, state) };
    default: {
      const unreachable: never = stmt;
      throw new Error("unsupported statement kind");
    }
  }
};

const typeLetStatement = (
  stmt: HirLetStatement,
  ctx: TypingContext,
  state: TypingState
): number => {
  if (stmt.pattern.kind === "tuple") {
    const annotated =
      stmt.pattern.typeAnnotation &&
      resolveTypeExpr(
        stmt.pattern.typeAnnotation,
        ctx,
        state,
        ctx.primitives.unknown
      );
    if (
      typeof annotated === "number" &&
      annotated !== ctx.primitives.unknown
    ) {
      const initializerType = typeExpression(
        stmt.initializer,
        ctx,
        state,
        { expectedType: annotated }
      );
      if (initializerType !== ctx.primitives.unknown) {
        ensureTypeMatches(
          initializerType,
          annotated,
          ctx,
          state,
          "let initializer"
        );
      }
      bindTuplePatternFromType(
        stmt.pattern,
        annotated,
        ctx,
        state,
        "declare",
        stmt.span
      );
      return getExprEffectRow(stmt.initializer, ctx);
    }
    bindTuplePatternFromExpr(
      stmt.pattern,
      stmt.initializer,
      ctx,
      state,
      "declare",
      stmt.span
    );
    return getExprEffectRow(stmt.initializer, ctx);
  }

  if (stmt.pattern.kind === "destructure") {
    const annotated =
      stmt.pattern.typeAnnotation &&
      resolveTypeExpr(
        stmt.pattern.typeAnnotation,
        ctx,
        state,
        ctx.primitives.unknown
      );

    const expectedType =
      typeof annotated === "number" && annotated !== ctx.primitives.unknown
        ? annotated
        : undefined;

    const initializerType = typeExpression(
      stmt.initializer,
      ctx,
      state,
      { expectedType }
    );

    if (
      typeof expectedType === "number" &&
      expectedType !== ctx.primitives.unknown &&
      initializerType !== ctx.primitives.unknown
    ) {
      ensureTypeMatches(
        initializerType,
        expectedType,
        ctx,
        state,
        "let initializer"
      );
    }

    const declaredType = expectedType ?? initializerType;
    bindDestructurePatternFromType(
      stmt.pattern,
      declaredType,
      ctx,
      state,
      "declare",
      stmt.span
    );
    return getExprEffectRow(stmt.initializer, ctx);
  }

  const expectedType =
    stmt.pattern.kind === "identifier" && stmt.pattern.typeAnnotation
      ? resolveTypeExpr(
          stmt.pattern.typeAnnotation,
          ctx,
          state,
          ctx.primitives.unknown
        )
      : undefined;
  const initializerType = typeExpression(
    stmt.initializer,
    ctx,
    state,
    { expectedType }
  );

  if (
    typeof expectedType === "number" &&
    expectedType !== ctx.primitives.unknown &&
    initializerType !== ctx.primitives.unknown
  ) {
    ensureTypeMatches(
      initializerType,
      expectedType,
      ctx,
      state,
      "let initializer"
    );
  }

  const declaredType = expectedType ?? initializerType;
  recordPatternType(stmt.pattern, declaredType, ctx, state, "declare");
  stmt.pattern.typeId = declaredType;
  return getExprEffectRow(stmt.initializer, ctx);
};
