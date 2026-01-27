import type { HirPattern } from "../../hir/index.js";
import type { HirExprId, SourceSpan, TypeId } from "../../ids.js";
import { ensureTypeMatches, resolveTypeExpr } from "../type-system.js";
import { getSymbolName } from "../type-system.js";
import { getStructuralFields } from "../type-system.js";
import { assertMutableBinding } from "./mutability.js";
import { typeExpression } from "../expressions.js";
import type { TypingContext, TypingState } from "../types.js";

export type PatternBindingMode = "declare" | "assign";

export const resolvePatternAnnotation = (
  pattern: HirPattern,
  ctx: TypingContext,
  state: TypingState
): TypeId | undefined =>
  pattern.typeAnnotation
    ? resolveTypeExpr(
        pattern.typeAnnotation,
        ctx,
        state,
        ctx.primitives.unknown
      )
    : undefined;

export const recordPatternType = (
  pattern: HirPattern,
  type: TypeId,
  ctx: TypingContext,
  state: TypingState,
  mode: PatternBindingMode,
  spanHint?: SourceSpan
): void => {
  switch (pattern.kind) {
    case "identifier": {
      const span = pattern.span ?? spanHint;
      const annotation =
        pattern.typeAnnotation &&
        resolveTypeExpr(
          pattern.typeAnnotation,
          ctx,
          state,
          ctx.primitives.unknown
        );
      const targetType = typeof annotation === "number" ? annotation : type;
      if (
        typeof annotation === "number" &&
        annotation !== ctx.primitives.unknown &&
        type !== ctx.primitives.unknown
      ) {
        ensureTypeMatches(
          type,
          annotation,
          ctx,
          state,
          `pattern ${getSymbolName(pattern.symbol, ctx)}`
        );
      }
      if (mode === "assign" && span) {
        assertMutableBinding({ symbol: pattern.symbol, span, ctx });
      }
      if (mode === "declare" || !ctx.valueTypes.has(pattern.symbol)) {
        ctx.valueTypes.set(pattern.symbol, targetType);
        pattern.typeId = targetType;
        return;
      }
      const existing = ctx.valueTypes.get(pattern.symbol);
      if (typeof existing !== "number") {
        throw new Error(
          `missing type for identifier ${getSymbolName(pattern.symbol, ctx)}`
        );
      }
      ensureTypeMatches(
        targetType,
        existing,
        ctx,
        state,
        `assignment to ${getSymbolName(pattern.symbol, ctx)}`
      );
      pattern.typeId = targetType;
      return;
    }
    case "wildcard":
      return;
    default:
      throw new Error(`unsupported pattern kind ${pattern.kind}`);
  }
};

export const bindDestructurePatternFromType = (
  pattern: HirPattern & { kind: "destructure" },
  type: TypeId,
  ctx: TypingContext,
  state: TypingState,
  mode: PatternBindingMode,
  originSpan?: SourceSpan
): void => {
  const annotation = resolvePatternAnnotation(pattern, ctx, state);
  const expected =
    typeof annotation === "number" && annotation !== ctx.primitives.unknown
      ? annotation
      : type;
  if (
    typeof annotation === "number" &&
    annotation !== ctx.primitives.unknown &&
    type !== ctx.primitives.unknown
  ) {
    ensureTypeMatches(
      type,
      annotation,
      ctx,
      state,
      mode === "declare" ? "destructure pattern" : "destructure assignment"
    );
  }

  pattern.typeId = expected;
  const fields = getStructuralFields(expected, ctx, state);
  if (!fields) {
    if (state.mode === "relaxed" && type === ctx.primitives.unknown) {
      pattern.fields.forEach((field) =>
        bindPatternFromType(
          field.pattern,
          ctx.primitives.unknown,
          ctx,
          state,
          mode,
          originSpan ?? field.pattern.span
        )
      );
      if (pattern.spread) {
        bindPatternFromType(
          pattern.spread,
          ctx.primitives.unknown,
          ctx,
          state,
          mode,
          originSpan ?? pattern.spread.span
        );
      }
      return;
    }
    throw new Error("destructure pattern requires a structural initializer");
  }

  const fieldByName = new Map<string, TypeId>(
    fields.map((field) => [field.name, field.type])
  );

  pattern.fields.forEach((field) => {
    const fieldType = fieldByName.get(field.name);
    if (typeof fieldType !== "number") {
      throw new Error(`object is missing field ${field.name}`);
    }
    bindPatternFromType(
      field.pattern,
      fieldType,
      ctx,
      state,
      mode,
      originSpan ?? field.pattern.span
    );
  });

  if (pattern.spread) {
    bindPatternFromType(
      pattern.spread,
      ctx.primitives.unknown,
      ctx,
      state,
      mode,
      originSpan ?? pattern.spread.span
    );
  }
};

export const bindPatternFromType = (
  pattern: HirPattern,
  type: TypeId,
  ctx: TypingContext,
  state: TypingState,
  mode: PatternBindingMode,
  originSpan?: SourceSpan
): void => {
  switch (pattern.kind) {
    case "wildcard":
      return;
    case "identifier":
      return recordPatternType(pattern, type, ctx, state, mode, originSpan);
    case "tuple":
      return bindTuplePatternFromType(pattern, type, ctx, state, mode, originSpan);
    case "destructure":
      return bindDestructurePatternFromType(
        pattern,
        type,
        ctx,
        state,
        mode,
        originSpan
      );
    case "type":
      throw new Error("type patterns are not supported in binding positions");
  }
};

export const bindTuplePatternFromType = (
  pattern: HirPattern & { kind: "tuple" },
  type: TypeId,
  ctx: TypingContext,
  state: TypingState,
  mode: PatternBindingMode,
  originSpan?: SourceSpan
): void => {
  const annotation = resolvePatternAnnotation(pattern, ctx, state);
  const expected =
    typeof annotation === "number" && annotation !== ctx.primitives.unknown
      ? annotation
      : type;
  if (
    typeof annotation === "number" &&
    annotation !== ctx.primitives.unknown &&
    type !== ctx.primitives.unknown
  ) {
    ensureTypeMatches(
      type,
      annotation,
      ctx,
      state,
      mode === "declare" ? "tuple pattern" : "tuple assignment"
    );
  }
  pattern.typeId = expected;
  const fields = getStructuralFields(expected, ctx, state);
  if (!fields) {
    if (state.mode === "relaxed" && type === ctx.primitives.unknown) {
      pattern.elements.forEach((subPattern) => {
        if (subPattern.kind === "tuple") {
          bindTuplePatternFromType(
            subPattern,
            ctx.primitives.unknown,
            ctx,
            state,
            mode,
            originSpan ?? subPattern.span
          );
          return;
        }
        recordPatternType(
          subPattern,
          ctx.primitives.unknown,
          ctx,
          state,
          mode,
          subPattern.span ?? originSpan
        );
      });
      return;
    }
    throw new Error("tuple pattern requires a tuple initializer");
  }

  const fieldByIndex = new Map<string, TypeId>(
    fields.map((field) => [field.name, field.type])
  );

  if (fieldByIndex.size !== pattern.elements.length) {
    throw new Error("tuple pattern length mismatch");
  }

  pattern.elements.forEach((subPattern, index) => {
    const fieldType = fieldByIndex.get(`${index}`);
    if (typeof fieldType !== "number") {
      throw new Error(`tuple is missing element ${index}`);
    }
    if (subPattern.kind === "tuple") {
      bindTuplePatternFromType(
        subPattern,
        fieldType,
        ctx,
        state,
        mode,
        originSpan ?? subPattern.span
      );
      return;
    }
    recordPatternType(
      subPattern,
      fieldType,
      ctx,
      state,
      mode,
      subPattern.span ?? originSpan
    );
  });
};

export const bindTuplePatternFromExpr = (
  pattern: HirPattern & { kind: "tuple" },
  exprId: HirExprId,
  ctx: TypingContext,
  state: TypingState,
  mode: PatternBindingMode,
  originSpan?: SourceSpan,
  expectedType?: TypeId
): void => {
  const annotation = resolvePatternAnnotation(pattern, ctx, state);
  const expectedAnnotation =
    typeof annotation === "number" && annotation !== ctx.primitives.unknown
      ? annotation
      : undefined;
  const expectedFromCaller =
    typeof expectedType === "number" && expectedType !== ctx.primitives.unknown
      ? expectedType
      : undefined;
  const expected = expectedAnnotation ?? expectedFromCaller;
  if (
    expectedAnnotation &&
    expectedFromCaller &&
    expectedAnnotation !== expectedFromCaller
  ) {
    ensureTypeMatches(
      expectedFromCaller,
      expectedAnnotation,
      ctx,
      state,
      mode === "declare" ? "let pattern" : "assignment pattern"
    );
  }
  const initializerType = expected
    ? typeExpression(exprId, ctx, state, { expectedType: expected })
    : typeExpression(exprId, ctx, state);
  if (
    expected &&
    initializerType !== ctx.primitives.unknown &&
    expected !== ctx.primitives.unknown
  ) {
    ensureTypeMatches(
      initializerType,
      expected,
      ctx,
      state,
      mode === "declare" ? "let initializer" : "assignment"
    );
  }
  const patternType = expected ?? initializerType;
  pattern.typeId = patternType;
  const initializerExpr = ctx.hir.expressions.get(exprId);

  if (initializerExpr?.exprKind === "tuple") {
    if (initializerExpr.elements.length !== pattern.elements.length) {
      throw new Error("tuple pattern length mismatch");
    }

    pattern.elements.forEach((subPattern, index) => {
      const elementExprId = initializerExpr.elements[index]!;
      if (subPattern.kind === "tuple") {
        const subExpected = resolvePatternAnnotation(subPattern, ctx, state);
        bindTuplePatternFromExpr(
          subPattern,
          elementExprId,
          ctx,
          state,
          mode,
          originSpan ?? subPattern.span,
          subExpected
        );
        return;
      }
      const cached = ctx.table.getExprType(elementExprId);
      const elementType =
        typeof cached === "number"
          ? cached
          : typeExpression(elementExprId, ctx, state);
      recordPatternType(
        subPattern,
        elementType,
        ctx,
        state,
        mode,
        subPattern.span ?? originSpan
      );
    });
    return;
  }

  bindTuplePatternFromType(
    pattern,
    patternType,
    ctx,
    state,
    mode,
    originSpan ?? pattern.span
  );
};
