import type { HirMatchExpr, HirPattern, HirTypeExpr } from "../../hir/index.js";
import type { SourceSpan, SymbolId, TypeId } from "../../ids.js";
import { typeExpression } from "../expressions.js";
import { composeEffectRows, getExprEffectRow } from "../effects.js";
import {
  getNominalComponent,
  matchedUnionMembers,
  narrowTypeForPattern,
  ensureTypeMatches,
  resolveTypeExpr,
  getStructuralFields,
  getSymbolName,
} from "../type-system.js";
import {
  diagnosticFromCode,
  emitDiagnostic,
  normalizeSpan,
} from "../../../diagnostics/index.js";
import { mergeBranchType } from "./branching.js";
import type { TypingContext, TypingState } from "../types.js";
import { bindPatternFromType, recordPatternType } from "./patterns.js";

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
  let effectRow = getExprEffectRow(expr.discriminant, ctx);

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

    bindMatchPatternBindings(arm.pattern, narrowed, ctx, state, patternSpan);

    let armEffectRow = ctx.effects.emptyRow;
    if (typeof arm.guard === "number") {
      const guardType = typeExpression(arm.guard, ctx, state);
      ensureTypeMatches(
        guardType,
        ctx.primitives.bool,
        ctx,
        state,
        `match guard ${index + 1}`
      );
      armEffectRow = ctx.effects.compose(
        armEffectRow,
        getExprEffectRow(arm.guard, ctx)
      );
    }
    const valueType = withNarrowedDiscriminant(
      discriminantSymbol,
      narrowed,
      ctx,
      () => typeExpression(arm.value, ctx, state)
    );
    armEffectRow = ctx.effects.compose(
      armEffectRow,
      getExprEffectRow(arm.value, ctx)
    );
    effectRow = ctx.effects.compose(effectRow, armEffectRow);
    branchType = mergeBranchType({
      acc: branchType,
      next: valueType,
      ctx,
      state,
      span: ctx.hir.expressions.get(arm.value)?.span,
      context: "match arm",
    });

    if (!remainingMembers) {
      return;
    }

    if (arm.pattern.kind === "wildcard") {
      remainingMembers.clear();
      return;
    }

    const patternType =
      typeof arm.pattern.typeId === "number"
        ? arm.pattern.typeId
        : arm.pattern.kind === "type"
          ? resolveMatchPatternType({
              pattern: arm.pattern,
              ctx,
              state,
              hints: patternNominalHints,
              discriminantSpan,
              patternSpan,
            })
          : undefined;
    if (typeof patternType === "number") {
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

  ctx.effects.setExprEffect(expr.id, effectRow);
  return branchType ?? ctx.primitives.void;
};

const narrowMatchPattern = (
  discriminantType: TypeId,
  pattern: HirPattern,
  ctx: TypingContext,
  state: TypingState,
  reason: string,
  spans: { patternSpan: SourceSpan; discriminantSpan?: SourceSpan },
  patternHints?: NominalPatternHints
): TypeId => {
  switch (pattern.kind) {
    case "wildcard":
      pattern.typeId = discriminantType;
      return discriminantType;
    case "tuple": {
      const arity = pattern.elements.length;
      const candidates = collectTupleCandidates(discriminantType, arity, ctx, state);
      if (candidates.length === 0) {
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
        emitDiagnostic({
          ctx,
          code: "TY0002",
          params: {
            kind: "pattern-mismatch",
            patternLabel: `(${arity}-tuple)`,
            reason,
          },
          span: spans.patternSpan,
          related,
        });
        pattern.typeId = ctx.primitives.unknown;
        return ctx.primitives.unknown;
      }
      const narrowed =
        candidates.length === 1 ? candidates[0]! : ctx.arena.internUnion(candidates);
      pattern.typeId = narrowed;
      return narrowed;
    }
    case "type": {
      const patternType = resolveMatchPatternType({
        pattern,
        ctx,
        state,
        hints: patternHints,
        discriminantSpan: spans.discriminantSpan,
        patternSpan: spans.patternSpan,
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

const bindMatchPatternBindings = (
  pattern: HirPattern,
  narrowedType: TypeId,
  ctx: TypingContext,
  state: TypingState,
  spanHint: SourceSpan
): void => {
  const bindUnknown = (binding: HirPattern): void => {
    switch (binding.kind) {
      case "wildcard":
        return;
      case "identifier":
        recordPatternType(
          binding,
          ctx.primitives.unknown,
          ctx,
          state,
          "declare",
          binding.span ?? spanHint
        );
        return;
      case "tuple":
        binding.typeId = ctx.primitives.unknown;
        binding.elements.forEach((entry) => bindUnknown(entry));
        return;
      case "destructure":
        binding.typeId = ctx.primitives.unknown;
        binding.fields.forEach((field) => bindUnknown(field.pattern));
        if (binding.spread) {
          bindUnknown(binding.spread);
        }
        return;
      case "type":
        throw new Error("type patterns are not supported in binding positions");
    }
  };

  if (pattern.kind === "type" && pattern.binding) {
    if (narrowedType === ctx.primitives.unknown) {
      bindUnknown(pattern.binding);
      return;
    }
    bindPatternFromType(
      pattern.binding,
      narrowedType,
      ctx,
      state,
      "declare",
      spanHint
    );
  }

  if (pattern.kind === "tuple") {
    if (narrowedType === ctx.primitives.unknown) {
      bindUnknown(pattern);
      return;
    }
    bindPatternFromType(pattern, narrowedType, ctx, state, "declare", spanHint);
  }
};

const collectTupleCandidates = (
  discriminantType: TypeId,
  arity: number,
  ctx: TypingContext,
  state: TypingState
): TypeId[] => {
  if (discriminantType === ctx.primitives.unknown) {
    return [];
  }

  const isTupleType = (typeId: TypeId): boolean => {
    const fields = getStructuralFields(typeId, ctx, state);
    if (!fields) return false;
    if (fields.length !== arity) return false;
    return fields.every((field) => {
      const index = Number(field.name);
      return Number.isInteger(index) && index >= 0 && index < arity;
    });
  };

  const desc = ctx.arena.get(discriminantType);
  if (desc.kind === "union") {
    return desc.members.filter(isTupleType);
  }

  return isTupleType(discriminantType) ? [discriminantType] : [];
};

type NominalPatternHint = {
  nominal: TypeId;
  memberType: TypeId;
};

type NominalPatternHints = {
  unique: Map<SymbolId, NominalPatternHint>;
  ambiguous: Set<SymbolId>;
};

const collectNominalPatternHints = (
  discriminantType: TypeId,
  ctx: TypingContext
): NominalPatternHints | undefined => {
  const desc = ctx.arena.get(discriminantType);
  if (desc.kind !== "union") {
    return undefined;
  }

  const counts = new Map<SymbolId, number>();
  const unique = new Map<SymbolId, NominalPatternHint>();
  const ambiguous = new Set<SymbolId>();

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
      unique.set(owner, { nominal, memberType: member });
    } else {
      unique.delete(owner);
      ambiguous.add(owner);
    }
  });

  return unique.size > 0 || ambiguous.size > 0 ? { unique, ambiguous } : undefined;
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
  discriminantSpan,
  patternSpan,
}: {
  pattern: HirPattern & { kind: "type" };
  ctx: TypingContext;
  state: TypingState;
  hints?: NominalPatternHints;
  discriminantSpan?: SourceSpan;
  patternSpan: SourceSpan;
}): TypeId => {
  const namedType =
    pattern.type.typeKind === "named" ? pattern.type : undefined;
  const nominalSymbol =
    hints && namedType ? resolveNominalPatternSymbol(namedType, ctx) : undefined;
  const hasTypeArguments = (namedType?.typeArguments?.length ?? 0) > 0;

  if (nominalSymbol && hints && !hasTypeArguments) {
    const inferred = hints.unique.get(nominalSymbol);
    if (inferred) {
      return inferred.memberType;
    }

    const template = ctx.objects.getTemplate(nominalSymbol);
    const isGeneric = (template?.params.length ?? 0) > 0;
    if (isGeneric && hints.ambiguous.has(nominalSymbol)) {
      const related = discriminantSpan
        ? [
            diagnosticFromCode({
              code: "TY0002",
              params: { kind: "discriminant-note" },
              severity: "note",
              span: discriminantSpan,
            }),
          ]
        : undefined;

      emitDiagnostic({
        ctx,
        code: "TY0020",
        params: {
          kind: "ambiguous-nominal-match-pattern",
          typeName: getSymbolName(nominalSymbol, ctx),
        },
        span: patternSpan,
        related,
      });
    }
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
