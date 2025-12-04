import type {
  HirBlockExpr,
  HirLetStatement,
  HirStmtId,
} from "../../hir/index.js";
import type { TypeId } from "../ids.js";
import { typeExpression } from "../expressions.js";
import {
  bindTuplePatternFromExpr,
  bindTuplePatternFromType,
  recordPatternType,
} from "./patterns.js";
import { ensureTypeMatches, resolveTypeExpr } from "../type-system.js";
import type { TypingContext, TypingState } from "../types.js";

export const typeBlockExpr = (
  expr: HirBlockExpr,
  ctx: TypingContext,
  state: TypingState,
  expectedType?: TypeId
): TypeId => {
  expr.statements.forEach((stmtId) => typeStatement(stmtId, ctx, state));
  if (typeof expr.value === "number") {
    return typeExpression(expr.value, ctx, state, expectedType);
  }
  return ctx.primitives.void;
};

const typeStatement = (
  stmtId: HirStmtId,
  ctx: TypingContext,
  state: TypingState
): void => {
  const stmt = ctx.hir.statements.get(stmtId);
  if (!stmt) {
    throw new Error(`missing HirStatement ${stmtId}`);
  }

  switch (stmt.kind) {
    case "expr-stmt":
      typeExpression(stmt.expr, ctx, state);
      return;
    case "return":
      if (typeof state.currentFunction?.returnType !== "number") {
        throw new Error("return statement outside of function");
      }

      const expectedReturnType = state.currentFunction.returnType;
      if (typeof stmt.value === "number") {
        const valueType = typeExpression(
          stmt.value,
          ctx,
          state,
          expectedReturnType
        );
        ensureTypeMatches(
          valueType,
          expectedReturnType,
          ctx,
          state,
          "return statement"
        );
        return;
      }

      ensureTypeMatches(
        ctx.primitives.void,
        expectedReturnType,
        ctx,
        state,
        "return statement"
      );
      return;
    case "let":
      typeLetStatement(stmt, ctx, state);
      return;
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
