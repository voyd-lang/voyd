import { Match } from "../../syntax-objects/match.js";
import { UnionType, Type } from "../../syntax-objects/types.js";
import { typesAreCompatible } from "../resolution/index.js";
import { checkVarTypes } from "./check-var.js";
import { checkTypes } from "./check-types.js";

export const checkMatch = (match: Match) => {
  if (match.bindVariable) {
    checkVarTypes(match.bindVariable);
  }

  if (match.baseType?.isUnionType()) {
    return checkUnionMatch(match);
  }

  return checkObjectMatch(match);
};

const checkMatchCases = (match: Match) => {
  for (const mCase of match.cases) {
    checkTypes(mCase.expr);

    if (!mCase.matchType) {
      throw new Error(
        `Cannot resolve type for match case at ${mCase.expr.location}`
      );
    }

    if (!typesAreCompatible(mCase.expr.type, match.type)) {
      const expected = match.type?.name.value ?? "unknown";
      const actual = mCase.expr.type?.name.value ?? "unknown";
      throw new Error(
        `Match case at ${mCase.expr.location} returns ${actual} but expected ${expected}`
      );
    }
  }
};

const checkUnionMatch = (match: Match) => {
  const union = match.baseType as UnionType;

  const matched = match.cases
    .map((c) => c.matchType?.name.value)
    .filter((n): n is string => !!n);
  const unionTypes = union.types.map((t: Type) => t.name.value);

  if (!match.defaultCase) {
    const missing = unionTypes.filter((t: string) => !matched.includes(t));
    if (missing.length) {
      throw new Error(
        `Match on ${union.name.value} is not exhaustive at ${match.location}. Missing cases: ${missing.join(", ")}`
      );
    }
  }

  checkMatchCases(match);

  const badCase = match.cases.find((mCase) =>
    !union.types.some((type: Type) =>
      typesAreCompatible(mCase.matchType, type)
    )
  );

  if (badCase) {
    const caseName = badCase.matchType?.name.value ?? "unknown";
    throw new Error(
      `Match case ${caseName} is not part of union ${union.name.value} at ${match.location}`
    );
  }

  return match;
};

/** Check a match against an object type */
const checkObjectMatch = (match: Match) => {
  const baseName = match.baseType?.name.value ?? "object";

  if (!match.defaultCase) {
    throw new Error(
      `Match on ${baseName} must have a default case at ${match.location}`
    );
  }

  if (!match.baseType || !match.baseType.isObjectType()) {
    throw new Error(
      `Cannot determine type of value being matched at ${match.location}`
    );
  }

  checkMatchCases(match);

  return match;
};
