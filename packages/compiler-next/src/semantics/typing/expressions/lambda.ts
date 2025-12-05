import type {
  HirLambdaExpr,
  HirPattern,
} from "../../hir/index.js";
import type {
  SourceSpan,
  SymbolId,
  TypeId,
  TypeParamId,
} from "../../ids.js";
import {
  bindTypeParamsFromType,
  ensureTypeMatches,
  resolveTypeExpr,
  getSymbolName,
} from "../type-system.js";
import { typeExpression } from "../expressions.js";
import {
  enforceTypeParamConstraint,
  mergeSubstitutions,
} from "./call.js";
import {
  bindTuplePatternFromType,
  recordPatternType,
  resolvePatternAnnotation,
} from "./patterns.js";
import { applyCurrentSubstitution } from "./shared.js";
import type { TypingContext, TypingState } from "../types.js";

export const typeLambdaExpr = (
  expr: HirLambdaExpr,
  ctx: TypingContext,
  state: TypingState,
  expectedType?: TypeId
): TypeId => {
  const appliedExpected =
    typeof expectedType === "number"
      ? applyCurrentSubstitution(expectedType, ctx, state)
      : undefined;
  const expectedDesc =
    typeof appliedExpected === "number"
      ? ctx.arena.get(appliedExpected)
      : undefined;
  const expectedFn =
    expectedDesc && expectedDesc.kind === "function" ? expectedDesc : undefined;
  const expectedReturn =
    typeof expectedFn?.returnType === "number" &&
    expectedFn.returnType !== ctx.primitives.unknown
      ? expectedFn.returnType
      : undefined;

  const typeParamMap = new Map<SymbolId, TypeId>();
  const typeParams =
    expr.typeParameters?.map((param) => {
      const typeParam = ctx.arena.freshTypeParam();
      const typeRef = ctx.arena.internTypeParamRef(typeParam);
      typeParamMap.set(param.symbol, typeRef);
      const constraint = param.constraint
        ? resolveTypeExpr(
            param.constraint,
            ctx,
            state,
            ctx.primitives.unknown,
            typeParamMap
          )
        : undefined;
      const defaultType = param.defaultType
        ? resolveTypeExpr(
            param.defaultType,
            ctx,
            state,
            ctx.primitives.unknown,
            typeParamMap
          )
        : undefined;
      return {
        symbol: param.symbol,
        typeParam,
        typeRef,
        constraint,
        defaultType,
      };
    }) ?? [];

  const typeParamBindings = new Map<TypeParamId, TypeId>();
  const resolvedParams = expr.parameters.map((param, index) => {
    const expectedParamType = expectedFn?.parameters[index]?.type;
    const resolvedType = param.type
      ? resolveTypeExpr(
          param.type,
          ctx,
          state,
          ctx.primitives.unknown,
          typeParamMap
        )
      : typeof expectedParamType === "number"
      ? expectedParamType
      : ctx.primitives.unknown;
    if (typeof expectedParamType === "number") {
      bindTypeParamsFromType(
        resolvedType,
        expectedParamType,
        typeParamBindings,
        ctx,
        state
      );
    }
    return { ...param, resolvedType };
  });

  const annotatedReturn = expr.returnType
    ? resolveTypeExpr(
        expr.returnType,
        ctx,
        state,
        ctx.primitives.unknown,
        typeParamMap
      )
    : undefined;

  if (
    typeof expectedReturn === "number" &&
    typeof annotatedReturn === "number"
  ) {
    bindTypeParamsFromType(
      annotatedReturn,
      expectedReturn,
      typeParamBindings,
      ctx,
      state
    );
  }

  typeParams.forEach((param) => {
    if (typeParamBindings.has(param.typeParam)) {
      return;
    }
    if (typeof param.defaultType === "number") {
      typeParamBindings.set(param.typeParam, param.defaultType);
    }
  });

  typeParams.forEach((param) => {
    if (typeParamBindings.has(param.typeParam)) {
      return;
    }
    typeParamBindings.set(param.typeParam, ctx.primitives.unknown);
  });

  const baseSubstitution = substitutionFromBindings(typeParamBindings);
  const mergedSubstitution = mergeSubstitutions(
    baseSubstitution,
    state.currentFunction?.substitution,
    ctx
  );
  const mergedTypeParams =
    (state.currentFunction?.typeParams?.size ?? 0) + typeParamMap.size > 0
      ? new Map([
          ...(state.currentFunction?.typeParams?.entries() ?? []),
          ...typeParamMap.entries(),
        ])
      : undefined;

  const appliedParams = resolvedParams.map((param) => ({
    ...param,
    appliedType: ctx.arena.substitute(param.resolvedType, mergedSubstitution),
  }));

  appliedParams.forEach((param) => {
    bindParameterPattern(
      param.pattern,
      param.appliedType,
      param.span,
      ctx,
      state
    );
    if (typeof param.defaultValue === "number") {
      const defaultType = typeExpression(
        param.defaultValue,
        ctx,
        state,
        param.appliedType
      );
      ensureTypeMatches(
        defaultType,
        param.appliedType,
        ctx,
        state,
        `default value for parameter ${getSymbolName(param.symbol, ctx)}`
      );
    }
  });

  const returnHint =
    (typeof annotatedReturn === "number" ? annotatedReturn : expectedReturn) ??
    ctx.primitives.unknown;
  const appliedReturnHint =
    typeof returnHint === "number"
      ? ctx.arena.substitute(returnHint, mergedSubstitution)
      : ctx.primitives.unknown;

  const previousFunction = state.currentFunction;
  const lambdaInstanceKey = previousFunction?.instanceKey
    ? `${previousFunction.instanceKey}::lambda${expr.id}`
    : `lambda${expr.id}`;
  state.currentFunction = {
    returnType: appliedReturnHint,
    instanceKey: lambdaInstanceKey,
    typeParams: mergedTypeParams,
    substitution: mergedSubstitution,
    memberOf: previousFunction?.memberOf,
    functionSymbol: previousFunction?.functionSymbol,
  };

  let bodyType: TypeId;
  try {
    bodyType = typeExpression(expr.body, ctx, state, appliedReturnHint);
  } finally {
    state.currentFunction = previousFunction;
  }

  if (typeof expectedReturn === "number") {
    bindTypeParamsFromType(
      annotatedReturn ?? bodyType,
      expectedReturn,
      typeParamBindings,
      ctx,
      state
    );
  }

  const finalSubstitution = mergeSubstitutions(
    substitutionFromBindings(typeParamBindings),
    previousFunction?.substitution,
    ctx
  );

  const finalParams = appliedParams.map((param) => ({
    label: param.label,
    type: ctx.arena.substitute(param.resolvedType, finalSubstitution),
  }));
  const substitutedBodyType = ctx.arena.substitute(bodyType, finalSubstitution);
  const annotatedReturnApplied =
    typeof annotatedReturn === "number"
      ? ctx.arena.substitute(annotatedReturn, finalSubstitution)
      : undefined;
  const expectedReturnApplied =
    typeof expectedReturn === "number"
      ? ctx.arena.substitute(expectedReturn, finalSubstitution)
      : undefined;

  const finalReturn =
    annotatedReturnApplied ??
    expectedReturnApplied ??
    substitutedBodyType ??
    ctx.primitives.unknown;

  if (typeof annotatedReturnApplied === "number") {
    ensureTypeMatches(
      substitutedBodyType,
      annotatedReturnApplied,
      ctx,
      state,
      "lambda return type"
    );
  } else if (typeof expectedReturnApplied === "number") {
    ensureTypeMatches(
      substitutedBodyType,
      expectedReturnApplied,
      ctx,
      state,
      "lambda return type"
    );
  }

  typeParams.forEach((param) =>
    enforceTypeParamConstraint(param, finalSubstitution, ctx, state)
  );

  return ctx.arena.internFunction({
    parameters: finalParams.map(({ type, label }) => ({
      type,
      label,
      optional: false,
    })),
    returnType: finalReturn,
    effects: ctx.primitives.defaultEffectRow,
  });
};

const substitutionFromBindings = (
  bindings: ReadonlyMap<TypeParamId, TypeId>
): ReadonlyMap<TypeParamId, TypeId> => new Map(bindings);

const bindParameterPattern = (
  pattern: HirPattern,
  type: TypeId,
  span: SourceSpan | undefined,
  ctx: TypingContext,
  state: TypingState
): void => {
  if (pattern.kind === "tuple") {
    bindTuplePatternFromType(pattern, type, ctx, state, "declare", span);
    return;
  }
  recordPatternType(pattern, type, ctx, state, "declare", span);
};
