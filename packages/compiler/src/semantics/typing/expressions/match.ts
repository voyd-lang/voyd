import type { HirMatchExpr, HirPattern, HirTypeExpr } from "../../hir/index.js";
import type { SourceSpan, SymbolId, TypeId } from "../../ids.js";
import { typeExpression, type TypeExpressionOptions } from "../expressions.js";
import { getExprEffectRow } from "../effects.js";
import {
  getNominalComponent,
  matchedUnionMembers,
  narrowTypeForPattern,
  ensureTypeMatches,
  resolveTypeExpr,
  unfoldRecursiveType,
  getStructuralFields,
  getSymbolName,
} from "../type-system.js";
import {
  diagnosticFromCode,
  DiagnosticError,
  emitDiagnostic,
  normalizeSpan,
} from "../../../diagnostics/index.js";
import { mergeBranchType } from "./branching.js";
import type { TypingContext, TypingState } from "../types.js";
import { localSymbolForSymbolRef } from "../symbol-ref-utils.js";
import { bindPatternFromType, recordPatternType } from "./patterns.js";

export const typeMatchExpr = (
  expr: HirMatchExpr,
  ctx: TypingContext,
  state: TypingState,
  options: TypeExpressionOptions
): TypeId => {
  const discardValue = options.discardValue === true;
  const rawDiscriminantType = typeExpression(expr.discriminant, ctx, state);
  const discriminantType = unfoldRecursiveType(rawDiscriminantType, ctx);
  const discriminantExpr = ctx.hir.expressions.get(expr.discriminant);
  const discriminantSymbol =
    discriminantExpr?.exprKind === "identifier"
      ? discriminantExpr.symbol
      : undefined;
  const coverage = createMatchCoverageTracker({
    discriminantType,
    ctx,
    state,
  });

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
      coverage.patternNominalHints
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
      () => typeExpression(arm.value, ctx, state, { discardValue })
    );
    armEffectRow = ctx.effects.compose(
      armEffectRow,
      getExprEffectRow(arm.value, ctx)
    );
    effectRow = ctx.effects.compose(effectRow, armEffectRow);
    if (!discardValue) {
      branchType = mergeBranchType({
        acc: branchType,
        next: valueType,
        ctx,
        state,
        span: ctx.hir.expressions.get(arm.value)?.span,
        context: "match arm",
      });
    }

    coverage.trackArm({
      arm,
      armIndex: index + 1,
      patternSpan,
      discriminantSpan,
    });
  });

  coverage.ensureExhaustive(expr.span);

  ctx.effects.setExprEffect(expr.id, effectRow);
  return discardValue ? ctx.primitives.void : (branchType ?? ctx.primitives.void);
};

type MatchCoverageTracker = {
  patternNominalHints?: NominalPatternHints;
  trackArm: (input: {
    arm: HirMatchExpr["arms"][number];
    armIndex: number;
    patternSpan: SourceSpan;
    discriminantSpan?: SourceSpan;
  }) => void;
  ensureExhaustive: (span: SourceSpan) => void;
};

const createMatchCoverageTracker = ({
  discriminantType,
  ctx,
  state,
}: {
  discriminantType: TypeId;
  ctx: TypingContext;
  state: TypingState;
}): MatchCoverageTracker => {
  const discriminantDesc = ctx.arena.get(discriminantType);
  if (discriminantDesc.kind !== "union") {
    return {
      patternNominalHints: undefined,
      trackArm: () => undefined,
      ensureExhaustive: () => undefined,
    };
  }

  const remainingMembers = new Set(discriminantDesc.members);
  const patternNominalHints = collectNominalPatternHints(discriminantType, ctx);

  return {
    patternNominalHints,
    trackArm: ({ arm, armIndex, patternSpan, discriminantSpan }) => {
      if (arm.pattern.kind === "wildcard") {
        if (state.mode === "strict" && remainingMembers.size === 0) {
          reportRedundantMatchArm({
            ctx,
            armIndex,
            pattern: arm.pattern,
            span: patternSpan,
          });
        }
        remainingMembers.clear();
        return;
      }

      const patternType = resolvePatternCoverageType({
        pattern: arm.pattern,
        discriminantType,
        ctx,
        state,
        hints: patternNominalHints,
        discriminantSpan,
        patternSpan,
      });
      if (typeof patternType !== "number") {
        return;
      }

      const matched = matchedUnionMembers(patternType, remainingMembers, ctx, state);
      if (
        state.mode === "strict" &&
        patternType !== ctx.primitives.unknown &&
        matched.length === 0
      ) {
        reportRedundantMatchArm({
          ctx,
          armIndex,
          pattern: arm.pattern,
          span: patternSpan,
        });
      }
      matched.forEach((member) => remainingMembers.delete(member));
    },
    ensureExhaustive: (span) => {
      if (remainingMembers.size === 0) {
        return;
      }
      emitDiagnostic({
        ctx,
        code: "TY0003",
        params: { kind: "non-exhaustive-match" },
        span,
      });
    },
  };
};

const resolvePatternCoverageType = ({
  pattern,
  discriminantType,
  ctx,
  state,
  hints,
  discriminantSpan,
  patternSpan,
}: {
  pattern: HirPattern;
  discriminantType: TypeId;
  ctx: TypingContext;
  state: TypingState;
  hints?: NominalPatternHints;
  discriminantSpan?: SourceSpan;
  patternSpan: SourceSpan;
}): TypeId | undefined => {
  if (typeof pattern.typeId === "number") {
    return pattern.typeId;
  }

  if (pattern.kind !== "type") {
    return undefined;
  }

  return resolveMatchPatternType({
    pattern,
    discriminantType,
    ctx,
    state,
    hints,
    discriminantSpan,
    patternSpan,
  });
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
      let patternType: TypeId;
      try {
        patternType = resolveMatchPatternType({
          pattern,
          discriminantType,
          ctx,
          state,
          hints: patternHints,
          discriminantSpan: spans.discriminantSpan,
          patternSpan: spans.patternSpan,
        });
      } catch (error) {
        if (
          error instanceof DiagnosticError &&
          error.diagnostic.code === "TY0026"
        ) {
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
        throw error;
      }
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
    const owner = localSymbolForSymbolRef(nominalDesc.owner, ctx);
    if (typeof owner !== "number") {
      return;
    }
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

const reportRedundantMatchArm = ({
  ctx,
  armIndex,
  pattern,
  span,
}: {
  ctx: TypingContext;
  armIndex: number;
  pattern: HirPattern;
  span: SourceSpan;
}): void => {
  ctx.diagnostics.report(
    diagnosticFromCode({
      code: "TY0039",
      params: {
        kind: "redundant-match-arm",
        armIndex,
        patternLabel: patternLabelForDiagnostic(pattern),
      },
      span,
    })
  );
};

const patternLabelForDiagnostic = (pattern: HirPattern): string => {
  switch (pattern.kind) {
    case "wildcard":
      return "_";
    case "tuple":
      return `(${pattern.elements.length}-tuple)`;
    case "type":
      return pattern.type.typeKind === "named"
        ? pattern.type.path.join("::")
        : "type pattern";
    default:
      return pattern.kind;
  }
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
  discriminantType,
  ctx,
  state,
  hints,
  discriminantSpan,
  patternSpan,
}: {
  pattern: HirPattern & { kind: "type" };
  discriminantType: TypeId;
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
  const aliasSymbol =
    namedType ? resolveAliasPatternSymbol(namedType, ctx) : undefined;
  const aliasTemplate =
    typeof aliasSymbol === "number"
      ? ctx.typeAliases.getTemplate(aliasSymbol)
      : undefined;
  const isGenericAlias = (aliasTemplate?.params.length ?? 0) > 0;
  const hasTypeArguments = (namedType?.typeArguments?.length ?? 0) > 0;

  if (aliasSymbol && isGenericAlias && !hasTypeArguments) {
    const inferred = inferAliasPatternType({
      aliasSymbol,
      discriminantType,
      ctx,
      state,
    });

    if (inferred.kind === "resolved") {
      return inferred.type;
    }

    if (inferred.kind === "ambiguous") {
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
          typeName: getSymbolName(aliasSymbol, ctx),
        },
        span: patternSpan,
        related,
      });
    }

    return ctx.primitives.unknown;
  }

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

const resolveAliasPatternSymbol = (
  typeExpr: HirTypeExpr | undefined,
  ctx: TypingContext
): SymbolId | undefined => {
  if (!typeExpr || typeExpr.typeKind !== "named") {
    return undefined;
  }

  if (typeof typeExpr.symbol === "number") {
    const symbol = typeExpr.symbol;
    if (ctx.typeAliases.hasTemplate(symbol)) {
      return symbol;
    }
  }

  const name = typeExpr.path.at(-1);
  if (!name) {
    return undefined;
  }
  return ctx.typeAliases.resolveName(name);
};

type AliasPatternInference =
  | { kind: "resolved"; type: TypeId }
  | { kind: "unresolved" }
  | { kind: "ambiguous" };

const inferAliasPatternType = ({
  aliasSymbol,
  discriminantType,
  ctx,
  state,
}: {
  aliasSymbol: SymbolId;
  discriminantType: TypeId;
  ctx: TypingContext;
  state: TypingState;
}): AliasPatternInference => {
  const template = ctx.typeAliases.getTemplate(aliasSymbol);
  if (!template || template.params.length === 0) {
    return { kind: "unresolved" };
  }

  const inferenceParams = template.params.map(() => ctx.arena.freshTypeParam());
  const inferenceParamMap = new Map<SymbolId, TypeId>();
  template.params.forEach((param, index) => {
    inferenceParamMap.set(
      param.symbol,
      ctx.arena.internTypeParamRef(inferenceParams[index]!),
    );
  });
  const inferenceTarget = resolveTypeExpr(
    template.target,
    ctx,
    state,
    ctx.primitives.unknown,
    inferenceParamMap,
  );

  const candidates = inferenceParams.map(() => new Set<TypeId>());
  let matched = false;
  const members = (() => {
    const desc = ctx.arena.get(discriminantType);
    return desc.kind === "union" ? desc.members : [discriminantType];
  })();

  members.forEach((member) => {
    const comparison = ctx.arena.unify(member, inferenceTarget, {
      location: ctx.hir.module.ast,
      reason: "match alias pattern inference",
      variance: "covariant",
      allowUnknown: state.mode === "relaxed",
    });
    if (!comparison.ok) {
      return;
    }
    matched = true;
    inferenceParams.forEach((param, index) => {
      const bound = comparison.substitution.get(param);
      if (typeof bound === "number") {
        candidates[index]!.add(bound);
      }
    });
  });

  if (!matched) {
    return { kind: "unresolved" };
  }

  if (candidates.some((entry) => entry.size > 1)) {
    return { kind: "ambiguous" };
  }

  const inferredSubstitution = new Map(
    inferenceParams.map((param, index) => {
      const [inferred] = candidates[index]!;
      return [param, inferred ?? ctx.primitives.unknown] as const;
    }),
  );
  return {
    kind: "resolved",
    type: ctx.arena.substitute(inferenceTarget, inferredSubstitution),
  };
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
