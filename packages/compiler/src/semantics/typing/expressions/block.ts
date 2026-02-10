import type { HirBlockExpr, HirLetStatement } from "../../hir/index.js";
import type { HirStmtId, SymbolId, TypeId } from "../../ids.js";
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
import { DiagnosticError, emitDiagnostic } from "../../../diagnostics/index.js";
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
  let firstError: DiagnosticError | undefined;

  expr.statements.forEach((stmtId) => {
    const stmtSpan = ctx.hir.statements.get(stmtId)?.span;
    const { type: stmtReturnType, effect: stmtEffect, error } = typeStatement(
      stmtId,
      ctx,
      state,
    );
    firstError ??= error;
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
    const valueType = typeExpressionWithRecovery({
      exprId: expr.value,
      expectedType,
      discardValue,
      ctx,
      state,
      onError: (error) => {
        firstError ??= error;
      },
    });
    effectRow = ctx.effects.compose(effectRow, getExprEffectRow(expr.value, ctx));
    ctx.effects.setExprEffect(expr.id, effectRow);
    if (firstError) {
      throw new DiagnosticError(firstError.diagnostic, ctx.diagnostics.diagnostics);
    }
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
  if (firstError) {
    throw new DiagnosticError(firstError.diagnostic, ctx.diagnostics.diagnostics);
  }
  return returnType ?? ctx.primitives.void;
};

const typeStatement = (
  stmtId: HirStmtId,
  ctx: TypingContext,
  state: TypingState,
): { type?: TypeId; effect: number; error?: DiagnosticError } => {
  const stmt = ctx.hir.statements.get(stmtId);
  if (!stmt) {
    throw new Error(`missing HirStatement ${stmtId}`);
  }

  try {
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
            { expectedType: expectedReturnType },
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
  } catch (error) {
    if (error instanceof DiagnosticError) {
      if (stmt.kind === "let") {
        seedFallbackTypesForLetStatement(stmt, ctx);
      }
      return { effect: ctx.effects.emptyRow, error };
    }
    throw error;
  }
};

const typeExpressionWithRecovery = ({
  exprId,
  expectedType,
  discardValue,
  ctx,
  state,
  onError,
}: {
  exprId: HirBlockExpr["value"];
  expectedType: TypeId | undefined;
  discardValue: boolean;
  ctx: TypingContext;
  state: TypingState;
  onError: (error: DiagnosticError) => void;
}): TypeId => {
  if (typeof exprId !== "number") {
    return ctx.primitives.unknown;
  }

  try {
    return typeExpression(exprId, ctx, state, {
      expectedType,
      discardValue,
    });
  } catch (error) {
    if (error instanceof DiagnosticError) {
      onError(error);
      ctx.effects.setExprEffect(exprId, ctx.effects.emptyRow);
      return discardValue ? ctx.primitives.void : ctx.primitives.unknown;
    }
    throw error;
  }
};

const typeLetStatement = (
  stmt: HirLetStatement,
  ctx: TypingContext,
  state: TypingState
): number => {
  const boundSymbols = collectPatternSymbols(stmt.pattern);
  boundSymbols.forEach((symbol) => ctx.activeValueTypeComputations.add(symbol));
  try {
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
            "let initializer",
            ctx.hir.expressions.get(stmt.initializer)?.span ?? stmt.span,
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
          "let initializer",
          ctx.hir.expressions.get(stmt.initializer)?.span ?? stmt.span,
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
        "let initializer",
        ctx.hir.expressions.get(stmt.initializer)?.span ?? stmt.span,
      );
    }

    const declaredType = expectedType ?? initializerType;
    recordPatternType(stmt.pattern, declaredType, ctx, state, "declare");
    stmt.pattern.typeId = declaredType;
    return getExprEffectRow(stmt.initializer, ctx);
  } finally {
    boundSymbols.forEach((symbol) =>
      ctx.activeValueTypeComputations.delete(symbol)
    );
  }
};

const collectPatternSymbols = (pattern: HirLetStatement["pattern"]): SymbolId[] => {
  switch (pattern.kind) {
    case "identifier":
      return [pattern.symbol];
    case "tuple":
      return pattern.elements.flatMap(collectPatternSymbols);
    case "destructure":
      return [
        ...pattern.fields.flatMap((field) => collectPatternSymbols(field.pattern)),
        ...(pattern.spread ? collectPatternSymbols(pattern.spread) : []),
      ];
    case "type":
      return pattern.binding ? collectPatternSymbols(pattern.binding) : [];
    case "wildcard":
      return [];
  }
};

const seedFallbackTypesForLetStatement = (
  stmt: HirLetStatement,
  ctx: TypingContext,
): void => {
  collectPatternSymbols(stmt.pattern).forEach((symbol) => {
    if (!ctx.valueTypes.has(symbol)) {
      ctx.valueTypes.set(symbol, ctx.primitives.unknown);
    }
  });
};
