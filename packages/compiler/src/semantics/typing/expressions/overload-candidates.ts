import type { SymbolId, TypeId, TypeParamId } from "../../ids.js";
import { typeSatisfies } from "../type-system.js";
import type { FunctionSignature, TypingContext, TypingState } from "../types.js";

export type ExpectedCallContext = {
  params?: readonly TypeId[];
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
}: {
  candidates: readonly T[];
  typeArguments?: readonly TypeId[];
}): T[] => {
  if (!typeArguments || typeArguments.length === 0) {
    return [...candidates];
  }
  return candidates.filter((candidate) => {
    const signature = signatureForOverloadCandidate(candidate);
    const typeParamCount = signature.typeParams?.length ?? 0;
    return typeArguments.length <= typeParamCount;
  });
};

export const filterCandidatesByExpectedReturnType = <
  T extends FunctionSignature | { signature: FunctionSignature },
>({
  candidates,
  expectedReturnType,
  typeArguments,
  ctx,
  state,
}: {
  candidates: readonly T[];
  expectedReturnType: TypeId | undefined;
  typeArguments?: readonly TypeId[];
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
    if (
      typeArguments &&
      typeArguments.length > 0 &&
      typeArguments.length > typeParams.length
    ) {
      return false;
    }
    const substitution = new Map<TypeParamId, TypeId>();
    typeParams.forEach((param, index) => {
      const explicitArg = typeArguments?.[index];
      if (typeof explicitArg === "number") {
        substitution.set(param.typeParam, explicitArg);
      }
    });
    const returnType =
      substitution.size > 0
        ? ctx.arena.substitute(signature.returnType, substitution)
        : signature.returnType;
    return typeSatisfies(returnType, expectedReturnType, ctx, state);
  });
};
