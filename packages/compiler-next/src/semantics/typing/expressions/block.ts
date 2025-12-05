import type { HirBlockExpr, HirLetStatement } from "../../hir/index.js";
import type { HirStmtId, TypeId } from "../../ids.js";
import { typeExpression } from "../expressions.js";
import {
  bindTuplePatternFromExpr,
  bindTuplePatternFromType,
  recordPatternType,
} from "./patterns.js";
import { mergeBranchType } from "./branching.js";
import { ensureTypeMatches, resolveTypeExpr } from "../type-system.js";
import type { TypingContext, TypingState } from "../types.js";

export const typeBlockExpr = (
  expr: HirBlockExpr,
  ctx: TypingContext,
  state: TypingState,
  expectedType?: TypeId
): TypeId => {
  let returnType: TypeId | undefined;

  expr.statements.forEach((stmtId) => {
    const stmtReturnType = typeStatement(stmtId, ctx, state);
    if (typeof stmtReturnType === "number") {
      returnType = mergeBranchType({
        acc: returnType,
        next: stmtReturnType,
        ctx,
        state,
      });
    }
  });

  if (typeof expr.value === "number") {
    const valueType = typeExpression(expr.value, ctx, state, expectedType);
    return mergeBranchType({
      acc: returnType,
      next: valueType,
      ctx,
      state,
    });
  }

  return returnType ?? ctx.primitives.void;
};

const typeStatement = (
  stmtId: HirStmtId,
  ctx: TypingContext,
  state: TypingState
): TypeId | undefined => {
  const stmt = ctx.hir.statements.get(stmtId);
  if (!stmt) {
    throw new Error(`missing HirStatement ${stmtId}`);
  }

  switch (stmt.kind) {
    case "expr-stmt":
      typeExpression(stmt.expr, ctx, state);
      return undefined;
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
      if (typeof stmt.value === "number") {
        const valueType = typeExpression(
          stmt.value,
          ctx,
          state,
          expectedReturnType
        );
        if (enforceReturnType) {
          ensureTypeMatches(
            valueType,
            expectedReturnType,
            ctx,
            state,
            "return statement"
          );
        }
        if (state.currentFunction) {
          state.currentFunction.observedReturnType = mergeBranchType({
            acc: state.currentFunction.observedReturnType,
            next: valueType,
            ctx,
            state,
          });
        }
        return valueType;
      }

      const voidType = ctx.primitives.void;
      if (enforceReturnType) {
        ensureTypeMatches(
          voidType,
          expectedReturnType,
          ctx,
          state,
            "return statement"
          );
        }
        if (state.currentFunction) {
          state.currentFunction.observedReturnType = mergeBranchType({
            acc: state.currentFunction.observedReturnType,
            next: voidType,
            ctx,
            state,
          });
        }
      return voidType;
    case "let":
      typeLetStatement(stmt, ctx, state);
      return undefined;
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
): void => {
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
        annotated
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
      return;
    }
    bindTuplePatternFromExpr(
      stmt.pattern,
      stmt.initializer,
      ctx,
      state,
      "declare",
      stmt.span
    );
    return;
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
    expectedType
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
};
