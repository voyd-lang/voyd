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
  expectedReturnType,
  expectedReturnCandidates,
  ctx,
  state,
}: {
  candidates: readonly T[];
  typeArguments: readonly TypeId[] | undefined;
  expectedReturnType: TypeId | undefined;
  expectedReturnCandidates: ReadonlySet<SymbolId> | undefined;
  ctx: TypingContext;
  state: TypingState;
}): {
  hintedCandidates: readonly T[];
  fallbackCandidates?: readonly T[];
} => {
  const candidatesForBudget = filterCandidatesByExplicitTypeArguments({
    candidates,
    typeArguments,
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
          ctx,
          state,
        });

  if (
    returnHintCandidates.length === 0 ||
    returnHintCandidates.length === candidatesForBudget.length
  ) {
    return { hintedCandidates: candidatesForBudget };
  }

  return {
    hintedCandidates: returnHintCandidates,
    fallbackCandidates: candidatesForBudget,
  };
};

export const findOverloadMatches = <T extends OverloadResolutionCandidate>({
  name,
  candidates,
  args,
  typeArguments,
  span,
  ctx,
  state,
  matchesCandidate,
  argsForCandidate,
  refineMatches,
}: {
  name: string;
  candidates: readonly T[];
  args: readonly Arg[];
  typeArguments: readonly TypeId[] | undefined;
  span: SourceSpan;
  ctx: TypingContext;
  state: TypingState;
  matchesCandidate: (candidate: T, args: readonly Arg[]) => boolean;
  argsForCandidate?: (candidate: T) => readonly Arg[];
  refineMatches?: (matches: readonly T[]) => readonly T[];
}): readonly T[] => {
  const shapeCompatibleCandidates = candidates.filter((candidate) =>
    signatureCallShapeCouldMatch({
      args,
      signature: candidate.signature,
      ctx,
      state,
    }),
  );
  enforceOverloadCandidateBudget({
    name,
    candidateCount: shapeCompatibleCandidates.length,
    ctx,
    span,
  });
  const matches = shapeCompatibleCandidates.filter((candidate) =>
    matchesCandidate(candidate, argsForCandidate ? argsForCandidate(candidate) : args),
  );
  const refined = refineMatches ? refineMatches(matches) : matches;
  return narrowOverloadMatches({ matches: refined, typeArguments, ctx, state });
};

const signatureCallShapeCouldMatch = ({
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
    if (!param.optional) {
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
        if (!params[index]!.optional) {
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
        if (hasField || runParam.optional) {
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

    if (param.optional) {
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

  return params.every((param) => param.optional || argLabels.has(param.label!));
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
  ctx,
}: {
  symbol: SymbolId;
  signature: FunctionSignature;
  typeArguments?: readonly TypeId[];
  ctx: TypingContext;
}) =>
  signature.typeParams && signature.typeParams.length > 0
    ? applyExplicitTypeArguments({
        signature,
        typeArguments,
        calleeSymbol: symbol,
        ctx,
      })
    : undefined;

export const specializeOverloadParameters = ({
  symbol,
  signature,
  typeArguments,
  ctx,
}: {
  symbol: SymbolId;
  signature: FunctionSignature;
  typeArguments?: readonly TypeId[];
  ctx: TypingContext;
}): readonly ParamSignature[] => {
  const explicitSubstitution = applyExplicitTypeArgumentSubstitution({
    symbol,
    signature,
    typeArguments,
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
  ctx,
  state,
}: {
  candidate: OverloadResolutionCandidate;
  other: OverloadResolutionCandidate;
  typeArguments: readonly TypeId[] | undefined;
  ctx: TypingContext;
  state: TypingState;
}): boolean => {
  const candidateParams = specializeOverloadParameters({
    symbol: candidate.symbol,
    signature: candidate.signature,
    typeArguments,
    ctx,
  });
  const otherParams = specializeOverloadParameters({
    symbol: other.symbol,
    signature: other.signature,
    typeArguments,
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
  ctx,
}: {
  candidate: OverloadResolutionCandidate;
  typeArguments: readonly TypeId[] | undefined;
  ctx: TypingContext;
}): number =>
  specializeOverloadParameters({
    symbol: candidate.symbol,
    signature: candidate.signature,
    typeArguments,
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

export const narrowOverloadMatches = <T extends OverloadResolutionCandidate>({
  matches,
  typeArguments,
  ctx,
  state,
}: {
  matches: readonly T[];
  typeArguments: readonly TypeId[] | undefined;
  ctx: TypingContext;
  state: TypingState;
}): readonly T[] => {
  if (matches.length <= 1) {
    return matches;
  }

  const maximalMatches = matches.filter((candidate) =>
    matches.every(
      (other) =>
        candidate === other ||
        !overloadDominates({
          candidate: other,
          other: candidate,
          typeArguments,
          ctx,
          state,
        }),
    ),
  );

  if (maximalMatches.length === 1) {
    return maximalMatches;
  }

  // Labeled parameter groups are structural: a value with extra fields can
  // satisfy a smaller labeled shape. Do not rank matches by "most fields
  // consumed" here; subset/superset structural overloads should remain
  // ambiguous until declaration-time validation rejects them.
  const minPenalty = Math.min(
    ...maximalMatches.map((candidate) =>
      overloadGenericityPenalty({
        candidate,
        typeArguments,
        ctx,
      }),
    ),
  );
  const leastGenericMatches = maximalMatches.filter(
    (candidate) =>
      overloadGenericityPenalty({
        candidate,
        typeArguments,
        ctx,
      }) === minPenalty,
  );

  if (leastGenericMatches.length === 1) {
    return leastGenericMatches;
  }

  const maxConstraintSpecificity = Math.max(
    ...leastGenericMatches.map(overloadConstraintSpecificity)
  );
  const mostConstrainedMatches = leastGenericMatches.filter(
    (candidate) => overloadConstraintSpecificity(candidate) === maxConstraintSpecificity
  );

  return mostConstrainedMatches.length === 1 ? mostConstrainedMatches : matches;
};
