import type { HirMatchExpr, HirPattern, HirTypeExpr } from "../../hir/index.js";
import type { SourceSpan, SymbolId, TypeId } from "../../ids.js";
import { typeExpression } from "../expressions.js";
import {
  getNominalComponent,
  matchedUnionMembers,
  narrowTypeForPattern,
  resolveTypeExpr,
} from "../type-system.js";
import {
  diagnosticFromCode,
  emitDiagnostic,
  normalizeSpan,
} from "../../../diagnostics/index.js";
import { mergeBranchType } from "./branching.js";
import type { TypingContext, TypingState } from "../types.js";

export const typeMatchExpr = (
  expr: HirMatchExpr,
  ctx: TypingContext,
  state: TypingState
): TypeId => {
  const discriminantType = typeExpression(expr.discriminant, ctx, state);
  const discriminantExpr = ctx.hir.expressions.get(expr.discriminant);
  const discriminantSymbol =
    discriminantExpr?.exprKind === "identifier"
      ? discriminantExpr.symbol
      : undefined;

  const discriminantDesc = ctx.arena.get(discriminantType);
  const unionMembers =
    discriminantDesc.kind === "union"
      ? [...discriminantDesc.members]
      : undefined;
  const patternNominalHints =
    discriminantDesc.kind === "union"
      ? collectNominalPatternHints(discriminantType, ctx)
      : undefined;
  const remainingMembers = unionMembers ? new Set(unionMembers) : undefined;

  let branchType: TypeId | undefined;

  expr.arms.forEach((arm, index) => {
    const patternSpan = normalizeSpan(arm.pattern.span, expr.span);
    const discriminantSpan = discriminantExpr?.span;
    const narrowed = narrowMatchPattern(
      discriminantType,
      arm.pattern,
      ctx,
      state,
      `match arm ${index + 1}`,
      {
        patternSpan,
        discriminantSpan,
      },
      patternNominalHints
    );
    const valueType = withNarrowedDiscriminant(
      discriminantSymbol,
      narrowed,
      ctx,
      () => typeExpression(arm.value, ctx, state)
    );
    branchType = mergeBranchType({
      acc: branchType,
      next: valueType,
      ctx,
      state,
    });

    if (!remainingMembers) {
      return;
    }

    if (arm.pattern.kind === "wildcard") {
      remainingMembers.clear();
      return;
    }

    if (arm.pattern.kind === "type") {
      const patternType =
        typeof arm.pattern.typeId === "number"
          ? arm.pattern.typeId
          : resolveMatchPatternType({
              pattern: arm.pattern,
              ctx,
              state,
              hints: patternNominalHints,
            });
      matchedUnionMembers(patternType, remainingMembers, ctx, state).forEach(
        (member) => remainingMembers.delete(member)
      );
    }
  });

  if (remainingMembers && remainingMembers.size > 0) {
    emitDiagnostic({
      ctx,
      code: "TY0003",
      params: { kind: "non-exhaustive-match" },
      span: expr.span,
    });
  }

  return branchType ?? ctx.primitives.void;
};

const narrowMatchPattern = (
  discriminantType: TypeId,
  pattern: HirPattern,
  ctx: TypingContext,
  state: TypingState,
  reason: string,
  spans: { patternSpan: SourceSpan; discriminantSpan?: SourceSpan },
  patternHints?: Map<SymbolId, NominalPatternHint>
): TypeId => {
  switch (pattern.kind) {
    case "wildcard":
      pattern.typeId = discriminantType;
      return discriminantType;
    case "type": {
      const patternType = resolveMatchPatternType({
        pattern,
        ctx,
        state,
        hints: patternHints,
      });
      const narrowed = narrowTypeForPattern(
        discriminantType,
        patternType,
        ctx,
        state
      );
      if (typeof narrowed !== "number") {
        const related = spans.discriminantSpan
          ? [
              diagnosticFromCode({
                code: "TY0002",
                params: { kind: "discriminant-note" },
                severity: "note",
                span: spans.discriminantSpan,
              }),
            ]
          : undefined;
        const patternLabel =
          pattern.type.typeKind === "named"
            ? pattern.type.path.join("::")
            : pattern.kind;
        emitDiagnostic({
          ctx,
          code: "TY0002",
          params: {
            kind: "pattern-mismatch",
            patternLabel,
            reason,
          },
          span: spans.patternSpan,
          related,
        });
      }
      const result =
        typeof narrowed === "number" ? narrowed : ctx.primitives.unknown;
      pattern.typeId = result;
      return result;
    }
    default:
      throw new Error(`unsupported match pattern ${pattern.kind}`);
  }
};

type NominalPatternHint = {
  nominal: TypeId;
  memberType: TypeId;
};

const collectNominalPatternHints = (
  discriminantType: TypeId,
  ctx: TypingContext
): Map<SymbolId, NominalPatternHint> | undefined => {
  const desc = ctx.arena.get(discriminantType);
  if (desc.kind !== "union") {
    return undefined;
  }

  const counts = new Map<SymbolId, number>();
  const hints = new Map<SymbolId, NominalPatternHint>();

  desc.members.forEach((member) => {
    const nominal = getNominalComponent(member, ctx);
    if (typeof nominal !== "number") {
      return;
    }
    const nominalDesc = ctx.arena.get(nominal);
    if (nominalDesc.kind !== "nominal-object") {
      return;
    }
    const owner = nominalDesc.owner;
    const count = (counts.get(owner) ?? 0) + 1;
    counts.set(owner, count);
    if (count === 1) {
      hints.set(owner, { nominal, memberType: member });
    } else {
      hints.delete(owner);
    }
  });

  return hints.size > 0 ? hints : undefined;
};

const resolveNominalPatternSymbol = (
  typeExpr: HirTypeExpr | undefined,
  ctx: TypingContext
): SymbolId | undefined => {
  if (!typeExpr || typeExpr.typeKind !== "named") {
    return undefined;
  }

  if (typeof typeExpr.symbol === "number") {
    const symbol = typeExpr.symbol;
    if (ctx.objects.getTemplate(symbol)) {
      return symbol;
    }
  }

  const name = typeExpr.path.at(-1);
  if (!name) {
    return undefined;
  }
  return ctx.objects.resolveName(name);
};

const resolveMatchPatternType = ({
  pattern,
  ctx,
  state,
  hints,
}: {
  pattern: HirPattern & { kind: "type" };
  ctx: TypingContext;
  state: TypingState;
  hints?: Map<SymbolId, NominalPatternHint>;
}): TypeId => {
  const namedType =
    pattern.type.typeKind === "named" ? pattern.type : undefined;
  const nominalSymbol =
    hints && namedType ? resolveNominalPatternSymbol(namedType, ctx) : undefined;
  const inferred =
    nominalSymbol && hints ? hints.get(nominalSymbol) : undefined;
  if (
    inferred &&
    (!namedType?.typeArguments || namedType.typeArguments.length === 0)
  ) {
    return inferred.memberType;
  }

  return resolveTypeExpr(pattern.type, ctx, state, ctx.primitives.unknown);
};

const withNarrowedDiscriminant = (
  symbol: SymbolId | undefined,
  narrowedType: TypeId,
  ctx: TypingContext,
  run: () => TypeId
): TypeId => {
  if (typeof symbol !== "number" || narrowedType === ctx.primitives.unknown) {
    return run();
  }

  const previous = ctx.valueTypes.get(symbol);
  ctx.valueTypes.set(symbol, narrowedType);
  try {
    return run();
  } finally {
    if (typeof previous === "number") {
      ctx.valueTypes.set(symbol, previous);
    } else {
      ctx.valueTypes.delete(symbol);
    }
  }
};
