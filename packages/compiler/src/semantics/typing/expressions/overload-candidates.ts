import type { SymbolId, TypeId, TypeParamId } from "../../ids.js";
import { satisfies as typeSatisfies } from "../type-relations.js";
import type {
  FunctionSignature,
  ParamSignature,
  TypingContext,
  TypingState,
} from "../types.js";

export type ExpectedCallContext = {
  params?: readonly ParamSignature[];
  expectedReturnCandidates?: ReadonlySet<SymbolId>;
};

const signatureForOverloadCandidate = <
  T extends FunctionSignature | { signature: FunctionSignature },
>(
  candidate: T,
): FunctionSignature =>
  "signature" in candidate ? candidate.signature : candidate;

export const filterCandidatesByExplicitTypeArguments = <
  T extends FunctionSignature | { signature: FunctionSignature },
>({
  candidates,
  typeArguments,
  targetTypeArguments,
}: {
  candidates: readonly T[];
  typeArguments?: readonly TypeId[];
  targetTypeArguments?: readonly TypeId[];
}): T[] => {
  if (
    (!typeArguments || typeArguments.length === 0) &&
    (!targetTypeArguments || targetTypeArguments.length === 0)
  ) {
    return [...candidates];
  }
  return candidates.filter((candidate) => {
    const signature = signatureForOverloadCandidate(candidate);
    const typeParamCount = signature.typeParams?.length ?? 0;
    return (typeArguments?.length ?? 0) + (targetTypeArguments?.length ?? 0) <= typeParamCount;
  });
};

export const filterCandidatesByExpectedReturnType = <
  T extends FunctionSignature | { signature: FunctionSignature },
>({
  candidates,
  expectedReturnType,
  typeArguments,
  targetTypeArguments,
  ctx,
  state,
}: {
  candidates: readonly T[];
  expectedReturnType: TypeId | undefined;
  typeArguments?: readonly TypeId[];
  targetTypeArguments?: readonly TypeId[];
  ctx: TypingContext;
  state: TypingState;
}): T[] => {
  if (
    typeof expectedReturnType !== "number" ||
    expectedReturnType === ctx.primitives.unknown
  ) {
    return [...candidates];
  }
  return candidates.filter((candidate) => {
    const signature = signatureForOverloadCandidate(candidate);
    const typeParams = signature.typeParams ?? [];
    const explicitCount = typeArguments?.length ?? 0;
    const targetCount = targetTypeArguments?.length ?? 0;
    if (explicitCount + targetCount > typeParams.length) {
      return false;
    }
    const substitution = new Map<TypeParamId, TypeId>();
    typeParams.forEach((param, index) => {
      const explicitArg = typeArguments?.[index];
      if (typeof explicitArg === "number") {
        substitution.set(param.typeParam, explicitArg);
      }
    });
    const targetStart = typeParams.length - targetCount;
    targetTypeArguments?.forEach((arg, index) => {
      const param = typeParams[targetStart + index];
      if (param) {
        substitution.set(param.typeParam, arg);
      }
    });
    const returnType =
      substitution.size > 0
        ? ctx.arena.substitute(signature.returnType, substitution)
        : signature.returnType;
    return typeSatisfies(returnType, expectedReturnType, ctx, state);
  });
};
