import { Call, Expr, Fn, Parameter } from "../../syntax-objects/index.js";
import { getExprType } from "./get-expr-type.js";
import { typesAreEquivalent } from "./types-are-equivalent.js";
import { resolveFnTypes } from "./resolve-fn-type.js";

export const getCallFn = (call: Call): Fn | undefined => {
  if (isPrimitiveFnCall(call)) return undefined;

  const unfilteredCandidates = call.resolveFns(call.fnName);
  const candidates = filterCandidates(call, unfilteredCandidates);

  if (!candidates.length) {
    return undefined;
  }

  if (candidates.length === 1) return candidates[0];
  return findBestFnMatch(candidates, call);
};

const filterCandidates = (call: Call, candidates: Fn[]): Fn[] =>
  candidates.flatMap((candidate) => {
    if (candidate.typeParameters) {
      return filterCandidateWithGenerics(call, candidate);
    }

    resolveFnTypes(candidate);
    const params = candidate.parameters;
    const matches = params.every((p, i) => parametersMatch(p, i, call));
    return matches ? candidate : [];
  });

const filterCandidateWithGenerics = (call: Call, candidate: Fn): Fn[] => {
  // Resolve generics
  if (!candidate.genericInstances) resolveFnTypes(candidate, call);

  // Fn not compatible with call
  if (!candidate.genericInstances?.length) return [];

  // First attempt
  const genericsInstances = filterCandidates(call, candidate.genericInstances);

  // If we have instances, return them
  if (genericsInstances.length) return genericsInstances;

  // If no instances, attempt to resolve generics with this call, as a compatible instance
  // is still possible
  const beforeLen = candidate.genericInstances.length;
  resolveFnTypes(candidate, call);
  const afterLen = candidate.genericInstances.length;

  if (beforeLen === afterLen) {
    // No new instances were created, so this call is not compatible
    return [];
  }

  return filterCandidates(call, candidate.genericInstances);
};

const parametersMatch = (p: Parameter, index: number, call: Call) => {
  const arg = call.argAt(index);
  if (!arg) return false;
  const argType = getExprType(arg);
  if (!argType) return false;
  const argLabel = getExprLabel(arg);
  const labelsMatch = p.label === argLabel;
  return typesAreEquivalent(argType, p.type!) && labelsMatch;
};

const findBestFnMatch = (candidates: Fn[], call: Call): Fn => {
  let winner: Fn | undefined = undefined;
  let tied = false;
  let lowestScore: number | undefined;
  for (const candidate of candidates) {
    const score = candidate.parameters.reduce((score, param, index) => {
      if (!param.type?.isObjectType()) {
        return score;
      }

      const argType = getExprType(call.argAt(index));
      if (!argType || !argType.isObjectType()) {
        throw new Error(`Could not determine type. I'm helpful >.<`);
      }

      const distance = argType.extensionDistance(param.type);
      return score + distance;
    }, 0);

    if (lowestScore === undefined) {
      lowestScore = score;
      winner = candidate;
    }

    if (score > lowestScore) {
      continue;
    }

    if (score < lowestScore) {
      lowestScore = score;
      winner = candidate;
      tied = false;
      continue;
    }

    tied = true;
  }

  if (!winner || tied) {
    throw new Error(`Ambiguous call ${JSON.stringify(call, null, 2)}`);
  }

  return winner;
};

const getExprLabel = (expr?: Expr): string | undefined => {
  if (!expr?.isCall()) return;
  if (!expr.calls(":")) return;
  const id = expr.argAt(0);
  if (!id?.isIdentifier()) return;
  return id.value;
};

const isPrimitiveFnCall = (call: Call): boolean => {
  const name = call.fnName.value;
  return (
    name === "export" ||
    name === "if" ||
    name === "return" ||
    name === "binaryen" ||
    name === ":" ||
    name === "="
  );
};
