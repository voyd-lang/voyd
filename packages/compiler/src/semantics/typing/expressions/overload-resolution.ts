import type { SourceSpan, SymbolId, TypeId, TypeParamId } from "../../ids.js";
import { emitDiagnostic, normalizeSpan } from "../../../diagnostics/index.js";
import type {
  Arg,
  FunctionSignature,
  ParamSignature,
  TypingContext,
  TypingState,
} from "../types.js";
import { getStructuralFields, getSymbolName } from "../type-system.js";
import { satisfies as typeSatisfies } from "../type-relations.js";
import {
  filterCandidatesByExpectedReturnType,
  filterCandidatesByExplicitTypeArguments,
} from "./overload-candidates.js";

export type OverloadResolutionCandidate = {
  symbol: SymbolId;
  signature: FunctionSignature;
};

export type OverloadCandidateScore<T extends OverloadResolutionCandidate> = {
  candidate: T;
  shapeMatch: boolean;
  argumentMatch: boolean;
  dominance: number;
  genericityPenalty: number;
  constraintSpecificity: number;
  lambdaCompatibility: number;
  expectedReturnCompatibility: boolean;
};

type OverloadScoreInput<T extends OverloadResolutionCandidate> = Omit<
  OverloadCandidateScore<T>,
  "dominance" | "genericityPenalty" | "constraintSpecificity"
>;

export type OverloadMatchScoreOverrides = {
  lambdaCompatibility?: number;
};

export const enforceOverloadCandidateBudget = ({
  name,
  candidateCount,
  ctx,
  span,
}: {
  name: string;
  candidateCount: number;
  ctx: TypingContext;
  span?: SourceSpan;
}): void => {
  if (candidateCount <= ctx.typeCheckBudget.maxOverloadCandidates) {
    return;
  }
  emitDiagnostic({
    ctx,
    code: "TY0041",
    params: {
      kind: "overload-candidate-budget-exceeded",
      name,
      candidates: candidateCount,
      maxCandidates: ctx.typeCheckBudget.maxOverloadCandidates,
    },
    span: normalizeSpan(span, ctx.hir.module.span),
  });
};

export const selectHintedOverloadCandidates = <T extends OverloadResolutionCandidate>({
  candidates,
  typeArguments,
  targetTypeArguments,
  expectedReturnType,
  expectedReturnCandidates,
  ctx,
  state,
}: {
  candidates: readonly T[];
  typeArguments: readonly TypeId[] | undefined;
  targetTypeArguments?: readonly TypeId[] | undefined;
  expectedReturnType: TypeId | undefined;
  expectedReturnCandidates: ReadonlySet<SymbolId> | undefined;
  ctx: TypingContext;
  state: TypingState;
}): {
  candidates: readonly T[];
  expectedReturnCompatibleSymbols?: ReadonlySet<SymbolId>;
} => {
  const candidatesForBudget = filterCandidatesByExplicitTypeArguments({
    candidates,
    typeArguments,
    targetTypeArguments,
  });

  const returnHintCandidates =
    expectedReturnCandidates && expectedReturnCandidates.size > 0
      ? candidatesForBudget.filter((candidate) =>
          expectedReturnCandidates.has(candidate.symbol),
        )
      : filterCandidatesByExpectedReturnType({
          candidates: candidatesForBudget,
          expectedReturnType,
          typeArguments,
          targetTypeArguments,
          ctx,
          state,
        });

  if (
    returnHintCandidates.length === 0 ||
    returnHintCandidates.length === candidatesForBudget.length
  ) {
    return { candidates: candidatesForBudget };
  }

  return {
    candidates: candidatesForBudget,
    expectedReturnCompatibleSymbols: new Set(
      returnHintCandidates.map((candidate) => candidate.symbol),
    ),
  };
};

export const findOverloadMatches = <T extends OverloadResolutionCandidate>({
  name,
  candidates,
  args,
  typeArguments,
  targetTypeArguments,
  span,
  ctx,
  state,
  matchesCandidate,
  argsForCandidate,
  scoreMatches,
  expectedReturnCompatible,
}: {
  name: string;
  candidates: readonly T[];
  args: readonly Arg[];
  typeArguments: readonly TypeId[] | undefined;
  targetTypeArguments?: readonly TypeId[] | undefined;
  span: SourceSpan;
  ctx: TypingContext;
  state: TypingState;
  matchesCandidate: (candidate: T, args: readonly Arg[]) => boolean;
  argsForCandidate?: (candidate: T) => readonly Arg[];
  scoreMatches?: (
    matches: readonly T[],
  ) => ReadonlyMap<T, OverloadMatchScoreOverrides>;
  expectedReturnCompatible?: (candidate: T) => boolean;
}): readonly T[] => {
  const shapedScores = candidates.map((candidate) => ({
    candidate,
    shapeMatch: signatureCallShapeCouldMatch({
      args,
      signature: candidate.signature,
      ctx,
      state,
    }),
    argumentMatch: false,
    lambdaCompatibility: 0,
    expectedReturnCompatibility: expectedReturnCompatible
      ? expectedReturnCompatible(candidate)
      : true,
  }));
  const shapeCompatibleCandidates = shapedScores
    .filter((score) => score.shapeMatch)
    .map(({ candidate }) => candidate);
  const expectedReturnShapeCompatibleCandidates = shapedScores
    .filter((score) => score.shapeMatch && score.expectedReturnCompatibility)
    .map(({ candidate }) => candidate);
  const candidatesForBudget =
    expectedReturnShapeCompatibleCandidates.length > 0
      ? expectedReturnShapeCompatibleCandidates
      : shapeCompatibleCandidates;
  enforceOverloadCandidateBudget({
    name,
    candidateCount: candidatesForBudget.length,
    ctx,
    span,
  });

  const candidatesForInitialMatch = candidatesForBudget;
  const initialMatches = candidatesForInitialMatch.filter((candidate) =>
    matchesCandidate(candidate, argsForCandidate ? argsForCandidate(candidate) : args),
  );
  const shouldCheckFallback =
    expectedReturnShapeCompatibleCandidates.length > 0 &&
    initialMatches.length === 0;
  if (shouldCheckFallback) {
    enforceOverloadCandidateBudget({
      name,
      candidateCount: shapeCompatibleCandidates.length,
      ctx,
      span,
    });
  }
  const matches = shouldCheckFallback
    ? shapeCompatibleCandidates.filter((candidate) =>
        matchesCandidate(
          candidate,
          argsForCandidate ? argsForCandidate(candidate) : args,
        ),
      )
    : initialMatches;
  const scoreOverrides = scoreMatches?.(matches) ?? new Map();
  const matchesSet = new Set(matches);
  const scoreInputs = shapedScores.map((score) => ({
    ...score,
    argumentMatch: matchesSet.has(score.candidate),
    lambdaCompatibility:
      scoreOverrides.get(score.candidate)?.lambdaCompatibility ?? 0,
  }));
  return selectOverloadMatchesFromScores({
    scores: scoreInputs,
    typeArguments,
    targetTypeArguments,
    ctx,
    state,
  });
};

export const signatureCallShapeCouldMatch = ({
  args,
  signature,
  ctx,
  state,
}: {
  args: readonly Arg[];
  signature: FunctionSignature;
  ctx: TypingContext;
  state: TypingState;
}): boolean => {
  const positional = positionalCallShapeCouldMatch(args, signature.parameters);
  if (typeof positional === "boolean") {
    return positional;
  }

  return callShapeCouldMatch({
    args,
    params: publicCallParametersForShape(signature),
    ctx,
    state,
  });
};

const publicCallParametersForShape = (
  signature: FunctionSignature,
): readonly ParamSignature[] =>
  signature.parameters.filter((param) => param.synthetic !== "stable-callsite-id");

const positionalCallShapeCouldMatch = (
  args: readonly Arg[],
  params: readonly ParamSignature[],
): boolean | undefined => {
  let required = 0;
  let total = 0;

  for (const arg of args) {
    if (arg.label !== undefined) {
      return undefined;
    }
  }

  for (const param of params) {
    if (param.synthetic === "stable-callsite-id") {
      continue;
    }
    if (param.label !== undefined) {
      return undefined;
    }
    total += 1;
    if (!param.optional && !param.defaulted) {
      required += 1;
    }
  }

  return args.length >= required && args.length <= total;
};

const callShapeCouldMatch = ({
  args,
  params,
  ctx,
  state,
}: {
  args: readonly Arg[];
  params: readonly ParamSignature[];
  ctx: TypingContext;
  state: TypingState;
}): boolean => {
  if (
    args.length > 0 &&
    args.every((arg) => arg.label !== undefined) &&
    params.length > 0 &&
    params.every((param) => param.label !== undefined)
  ) {
    return allLabeledCallShapeCouldMatch({ args, params });
  }

  let argIndex = 0;
  let paramIndex = 0;

  while (paramIndex < params.length) {
    const param = params[paramIndex]!;
    const arg = args[argIndex];

    if (!arg) {
      for (let index = paramIndex; index < params.length; index += 1) {
        if (!params[index]!.optional && !params[index]!.defaulted) {
          return false;
        }
      }
      return true;
    }

    if (param.label && arg.label === undefined) {
      const structuralFields = getStructuralFields(arg.type, ctx, state);
      if (!structuralFields) {
        return false;
      }

      let cursor = paramIndex;
      while (cursor < params.length) {
        const runParam = params[cursor]!;
        if (!runParam.label) {
          break;
        }
        const hasField = structuralFields.some((field) => field.name === runParam.label);
        if (hasField || runParam.optional || runParam.defaulted) {
          cursor += 1;
          continue;
        }
        return false;
      }

      if (cursor === paramIndex) {
        return false;
      }

      argIndex += 1;
      paramIndex = cursor;
      continue;
    }

    if (labelsCompatibleForShape(param, arg.label)) {
      argIndex += 1;
      paramIndex += 1;
      continue;
    }

    if (param.optional || param.defaulted) {
      paramIndex += 1;
      continue;
    }

    return false;
  }

  return argIndex === args.length;
};

const allLabeledCallShapeCouldMatch = ({
  args,
  params,
}: {
  args: readonly Arg[];
  params: readonly ParamSignature[];
}): boolean => {
  const argLabels = new Set(
    args
      .map((arg) => arg.label)
      .filter((label): label is string => typeof label === "string"),
  );
  const paramLabels = new Set(
    params
      .map((param) => param.label)
      .filter((label): label is string => typeof label === "string"),
  );

  const hasUnknownArgLabel = [...argLabels].some((label) => !paramLabels.has(label));
  if (hasUnknownArgLabel) {
    return false;
  }

  return params.every(
    (param) => param.optional || param.defaulted || argLabels.has(param.label!),
  );
};

const labelsCompatibleForShape = (
  param: ParamSignature,
  argLabel: string | undefined,
): boolean => {
  if (!param.label) {
    return argLabel === undefined;
  }

  return argLabel === param.label;
};

export const applyExplicitTypeArguments = ({
  signature,
  typeArguments,
  calleeSymbol,
  ctx,
}: {
  signature: FunctionSignature;
  typeArguments: readonly TypeId[] | undefined;
  calleeSymbol: SymbolId;
  ctx: TypingContext;
}): ReadonlyMap<TypeParamId, TypeId> | undefined => {
  if (!typeArguments || typeArguments.length === 0) {
    return undefined;
  }
  const params = signature.typeParams ?? [];
  if (typeArguments.length > params.length) {
    throw new Error(
      `function ${getSymbolName(
        calleeSymbol,
        ctx,
      )} received too many type arguments`,
    );
  }
  const substitution = new Map<TypeParamId, TypeId>();
  params.forEach((param, index) => {
    const arg = typeArguments[index];
    if (typeof arg === "number") {
      substitution.set(param.typeParam, arg);
    }
  });
  return substitution.size > 0 ? substitution : undefined;
};

export const applyExplicitTypeArgumentSubstitution = ({
  symbol,
  signature,
  typeArguments,
  targetTypeArguments,
  ctx,
}: {
  symbol: SymbolId;
  signature: FunctionSignature;
  typeArguments?: readonly TypeId[];
  targetTypeArguments?: readonly TypeId[];
  ctx: TypingContext;
}) =>
  signature.typeParams && signature.typeParams.length > 0
    ? mergeTypeArgumentSubstitutions({
        signature,
        typeArguments,
        targetTypeArguments,
        calleeSymbol: symbol,
        ctx,
      })
    : undefined;

const mergeTypeArgumentSubstitutions = ({
  signature,
  typeArguments,
  targetTypeArguments,
  calleeSymbol,
  ctx,
}: {
  signature: FunctionSignature;
  typeArguments?: readonly TypeId[];
  targetTypeArguments?: readonly TypeId[];
  calleeSymbol: SymbolId;
  ctx: TypingContext;
}): ReadonlyMap<TypeParamId, TypeId> | undefined => {
  const explicit = applyExplicitTypeArguments({
    signature,
    typeArguments,
    calleeSymbol,
    ctx,
  });
  if (!targetTypeArguments || targetTypeArguments.length === 0) {
    return explicit;
  }

  const params = signature.typeParams ?? [];
  const explicitCount = typeArguments?.length ?? 0;
  const totalCount = explicitCount + targetTypeArguments.length;
  if (totalCount > params.length) {
    throw new Error(
      `function ${getSymbolName(calleeSymbol, ctx)} received too many type arguments`,
    );
  }

  const start = params.length - targetTypeArguments.length;
  const target = new Map<TypeParamId, TypeId>();
  targetTypeArguments.forEach((arg, index) => {
    const param = params[start + index];
    if (param) {
      target.set(param.typeParam, arg);
    }
  });
  if (!explicit || explicit.size === 0) {
    return target.size > 0 ? target : undefined;
  }
  const merged = new Map<TypeParamId, TypeId>(explicit);
  target.forEach((value, key) => merged.set(key, value));
  return merged;
};

export const specializeOverloadParameters = ({
  symbol,
  signature,
  typeArguments,
  targetTypeArguments,
  ctx,
}: {
  symbol: SymbolId;
  signature: FunctionSignature;
  typeArguments?: readonly TypeId[];
  targetTypeArguments?: readonly TypeId[];
  ctx: TypingContext;
}): readonly ParamSignature[] => {
  const explicitSubstitution = applyExplicitTypeArgumentSubstitution({
    symbol,
    signature,
    typeArguments,
    targetTypeArguments,
    ctx,
  });
  if (!explicitSubstitution) {
    return signature.parameters;
  }

  return signature.parameters.map((param) => ({
    ...param,
    type: ctx.arena.substitute(param.type, explicitSubstitution),
  }));
};

const overloadDominates = ({
  candidate,
  other,
  typeArguments,
  targetTypeArguments,
  ctx,
  state,
}: {
  candidate: OverloadResolutionCandidate;
  other: OverloadResolutionCandidate;
  typeArguments: readonly TypeId[] | undefined;
  targetTypeArguments: readonly TypeId[] | undefined;
  ctx: TypingContext;
  state: TypingState;
}): boolean => {
  const candidateParams = specializeOverloadParameters({
    symbol: candidate.symbol,
    signature: candidate.signature,
    typeArguments,
    targetTypeArguments,
    ctx,
  });
  const otherParams = specializeOverloadParameters({
    symbol: other.symbol,
    signature: other.signature,
    typeArguments,
    targetTypeArguments,
    ctx,
  });
  if (candidateParams.length !== otherParams.length) {
    return false;
  }

  let strictlyMoreSpecific = false;
  for (let index = 0; index < candidateParams.length; index += 1) {
    const candidateParam = candidateParams[index]!;
    const otherParam = otherParams[index]!;
    if (
      candidateParam.label !== otherParam.label ||
      candidateParam.optional !== otherParam.optional
    ) {
      return false;
    }
    const candidateBareTypeParam = isBareTypeParamRef(candidateParam.type, ctx);
    const otherBareTypeParam = isBareTypeParamRef(otherParam.type, ctx);
    if (!candidateBareTypeParam && otherBareTypeParam) {
      strictlyMoreSpecific = true;
      continue;
    }
    if (candidateBareTypeParam && !otherBareTypeParam) {
      return false;
    }
    if (!typeSatisfies(candidateParam.type, otherParam.type, ctx, state)) {
      return false;
    }
    if (!typeSatisfies(otherParam.type, candidateParam.type, ctx, state)) {
      strictlyMoreSpecific = true;
    }
  }

  return strictlyMoreSpecific;
};

const isBareTypeParamRef = (type: TypeId, ctx: TypingContext): boolean =>
  ctx.arena.get(type).kind === "type-param-ref";

const unresolvedTypeParamPenalty = ({
  type,
  ctx,
  visiting = new Set<TypeId>(),
}: {
  type: TypeId;
  ctx: TypingContext;
  visiting?: Set<TypeId>;
}): number => {
  if (visiting.has(type)) {
    return 0;
  }
  visiting.add(type);
  const penalty = (() => {
    const desc = ctx.arena.get(type);
    switch (desc.kind) {
      case "type-param-ref":
        return 1;
      case "primitive":
        return 0;
      case "recursive":
        return unresolvedTypeParamPenalty({ type: desc.body, ctx, visiting });
      case "fixed-array":
        return unresolvedTypeParamPenalty({ type: desc.element, ctx, visiting });
      case "union":
        return desc.members.reduce(
          (sum, member) =>
            sum + unresolvedTypeParamPenalty({ type: member, ctx, visiting }),
          0,
        );
      case "intersection":
        return (
          (typeof desc.nominal === "number"
            ? unresolvedTypeParamPenalty({ type: desc.nominal, ctx, visiting })
            : 0) +
          (typeof desc.structural === "number"
            ? unresolvedTypeParamPenalty({
                type: desc.structural,
                ctx,
                visiting,
              })
            : 0) +
          (desc.traits?.reduce(
            (sum, trait) =>
              sum + unresolvedTypeParamPenalty({ type: trait, ctx, visiting }),
            0,
          ) ?? 0)
        );
      case "trait":
      case "nominal-object":
      case "value-object":
        return desc.typeArgs.reduce(
          (sum, arg) =>
            sum + unresolvedTypeParamPenalty({ type: arg, ctx, visiting }),
          0,
        );
      case "structural-object":
        return desc.fields.reduce(
          (sum, field) =>
            sum + unresolvedTypeParamPenalty({ type: field.type, ctx, visiting }),
          0,
        );
      case "function":
        return (
          desc.parameters.reduce(
            (sum, param) =>
              sum + unresolvedTypeParamPenalty({ type: param.type, ctx, visiting }),
            0,
          ) + unresolvedTypeParamPenalty({ type: desc.returnType, ctx, visiting })
        );
    }
  })();
  visiting.delete(type);
  return penalty;
};

const overloadGenericityPenalty = ({
  candidate,
  typeArguments,
  targetTypeArguments,
  ctx,
}: {
  candidate: OverloadResolutionCandidate;
  typeArguments: readonly TypeId[] | undefined;
  targetTypeArguments: readonly TypeId[] | undefined;
  ctx: TypingContext;
}): number =>
  specializeOverloadParameters({
    symbol: candidate.symbol,
    signature: candidate.signature,
    typeArguments,
    targetTypeArguments,
    ctx,
  }).reduce(
    (sum, param) =>
      sum +
      unresolvedTypeParamPenalty({ type: param.type, ctx }) +
      bareFunctionReturnTypeParamPenalty(param.type, ctx),
    0,
  );

const bareFunctionReturnTypeParamPenalty = (type: TypeId, ctx: TypingContext): number => {
  const desc = ctx.arena.get(type);
  return desc.kind === "function" && isBareTypeParamRef(desc.returnType, ctx) ? 2 : 0;
};

const overloadConstraintSpecificity = (
  candidate: OverloadResolutionCandidate
): number =>
  (candidate.signature.typeParams ?? []).reduce(
    (sum, param) => sum + (param.constraint ? 1 : 0),
    0
  );

const scoreOverloadMatches = <T extends OverloadResolutionCandidate>({
  matches,
  typeArguments,
  targetTypeArguments,
  ctx,
  state,
}: {
  matches: readonly T[];
  typeArguments: readonly TypeId[] | undefined;
  targetTypeArguments: readonly TypeId[] | undefined;
  ctx: TypingContext;
  state: TypingState;
}): readonly OverloadCandidateScore<T>[] =>
  matches.map((candidate) => {
    const isDominated = matches.some(
      (other) =>
        candidate !== other &&
        overloadDominates({
          candidate: other,
          other: candidate,
          typeArguments,
          targetTypeArguments,
          ctx,
          state,
        }),
    );
    return {
      candidate,
      shapeMatch: true,
      argumentMatch: true,
      dominance: isDominated ? 0 : 1,
      genericityPenalty: overloadGenericityPenalty({
        candidate,
        typeArguments,
        targetTypeArguments,
        ctx,
      }),
      constraintSpecificity: overloadConstraintSpecificity(candidate),
      lambdaCompatibility: 0,
      expectedReturnCompatibility: true,
    };
  });

const completeOverloadScores = <T extends OverloadResolutionCandidate>({
  scores,
  typeArguments,
  targetTypeArguments,
  ctx,
  state,
}: {
  scores: readonly OverloadScoreInput<T>[];
  typeArguments: readonly TypeId[] | undefined;
  targetTypeArguments: readonly TypeId[] | undefined;
  ctx: TypingContext;
  state: TypingState;
}): readonly OverloadCandidateScore<T>[] => {
  const candidates = scores
    .filter(
      (score) =>
        score.shapeMatch &&
        score.argumentMatch &&
        Number.isFinite(score.lambdaCompatibility),
    )
    .map(({ candidate }) => candidate);
  const scoredMatches = scoreOverloadMatches({
    matches: candidates,
    typeArguments,
    targetTypeArguments,
    ctx,
    state,
  });
  const scoredByCandidate = new Map(
    scoredMatches.map((score) => [score.candidate, score]),
  );

  return scores.map((score) => {
    const scored = scoredByCandidate.get(score.candidate);
    return {
      ...score,
      dominance: scored?.dominance ?? 0,
      genericityPenalty: scored?.genericityPenalty ?? Number.POSITIVE_INFINITY,
      constraintSpecificity: scored?.constraintSpecificity ?? 0,
    };
  });
};

const selectOverloadMatchesFromScores = <T extends OverloadResolutionCandidate>({
  scores,
  typeArguments,
  targetTypeArguments,
  ctx,
  state,
}: {
  scores: readonly OverloadScoreInput<T>[];
  typeArguments: readonly TypeId[] | undefined;
  targetTypeArguments?: readonly TypeId[] | undefined;
  ctx: TypingContext;
  state: TypingState;
}): readonly T[] => {
  const completedScores = completeOverloadScores({
    scores,
    typeArguments,
    targetTypeArguments,
    ctx,
    state,
  });
  const compatibleScores = completedScores.filter(
    (score) =>
      score.shapeMatch &&
      score.argumentMatch,
  );
  if (compatibleScores.length <= 1) {
    return compatibleScores.map(({ candidate }) => candidate);
  }

  const expectedReturnScores = selectExpectedReturnCompatibleScores(compatibleScores);
  if (expectedReturnScores.length === 1) {
    return expectedReturnScores.map(({ candidate }) => candidate);
  }

  const lambdaCompatibleScores = selectScoresByMax(
    expectedReturnScores,
    "lambdaCompatibility",
  );
  if (lambdaCompatibleScores.length === 1) {
    return lambdaCompatibleScores.map(({ candidate }) => candidate);
  }

  const maximalScores = selectScoresByMax(lambdaCompatibleScores, "dominance");
  if (maximalScores.length === 1) {
    return maximalScores.map(({ candidate }) => candidate);
  }

  // Labeled parameter groups are structural: a value with extra fields can
  // satisfy a smaller labeled shape. Do not rank matches by "most fields
  // consumed" here; subset/superset structural overloads should remain
  // ambiguous until declaration-time validation rejects them.
  const leastGenericScores = selectScoresByMin(
    maximalScores,
    "genericityPenalty",
  );
  if (leastGenericScores.length === 1) {
    return leastGenericScores.map(({ candidate }) => candidate);
  }

  const mostConstrainedScores = selectScoresByMax(
    leastGenericScores,
    "constraintSpecificity",
  );
  return mostConstrainedScores.map(({ candidate }) => candidate);
};

const selectExpectedReturnCompatibleScores = <T extends OverloadResolutionCandidate>(
  scores: readonly OverloadCandidateScore<T>[],
): readonly OverloadCandidateScore<T>[] => {
  const compatible = scores.filter((score) => score.expectedReturnCompatibility);
  return compatible.length > 0 ? compatible : scores;
};

const selectScoresByMax = <T extends OverloadResolutionCandidate>(
  scores: readonly OverloadCandidateScore<T>[],
  dimension: "lambdaCompatibility" | "dominance" | "constraintSpecificity",
): readonly OverloadCandidateScore<T>[] => {
  const max = Math.max(...scores.map((score) => score[dimension]));
  return scores.filter((score) => score[dimension] === max);
};

const selectScoresByMin = <T extends OverloadResolutionCandidate>(
  scores: readonly OverloadCandidateScore<T>[],
  dimension: "genericityPenalty",
): readonly OverloadCandidateScore<T>[] => {
  const min = Math.min(...scores.map((score) => score[dimension]));
  return scores.filter((score) => score[dimension] === min);
};

export const narrowOverloadMatches = <T extends OverloadResolutionCandidate>({
  matches,
  typeArguments,
  targetTypeArguments,
  ctx,
  state,
}: {
  matches: readonly T[];
  typeArguments: readonly TypeId[] | undefined;
  targetTypeArguments?: readonly TypeId[] | undefined;
  ctx: TypingContext;
  state: TypingState;
}): readonly T[] => {
  if (matches.length <= 1) {
    return matches;
  }

  return selectOverloadMatchesFromScores({
    scores: matches.map((candidate) => ({
      candidate,
      shapeMatch: true,
      argumentMatch: true,
      lambdaCompatibility: 0,
      expectedReturnCompatibility: true,
    })),
    typeArguments,
    targetTypeArguments,
    ctx,
    state,
  });
};
