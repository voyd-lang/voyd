import { Call, Expr, Fn } from "../../syntax-objects/index.js";
import { getExprType } from "./get-expr-type.js";
import { typesAreEquivalent } from "./types-are-equivalent.js";

export const getCallFn = (call: Call): Fn | undefined => {
  if (isPrimitiveFnCall(call)) return undefined;

  const candidates = call.resolveFns(call.fnName).filter((candidate) => {
    const params = candidate.parameters;
    return params.every((p, index) => {
      const arg = call.argAt(index);
      if (!arg) return false;
      const argType = getExprType(arg);
      if (!argType) return false;
      const argLabel = getExprLabel(arg);
      const labelsMatch = p.label === argLabel;
      return typesAreEquivalent(argType, p.type!) && labelsMatch;
    });
  });

  if (!candidates.length) {
    return undefined;
  }

  if (candidates.length === 1) return candidates[0];
  return findBestFnMatch(candidates, call);
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
