import { Block } from "../../syntax-objects/block.js";
import { Parameter, Variable } from "../../syntax-objects/index.js";
import { Match, MatchCase } from "../../syntax-objects/match.js";
import { getExprType } from "./get-expr-type.js";
import { resolveTypes } from "./resolve-types.js";

export const resolveMatch = (match: Match): Match => {
  match.operand = resolveTypes(match.operand);
  match.baseType = getExprType(match.operand);

  const binding = getBinding(match);
  match.cases = resolveCases(binding, match);

  return match;
};

const resolveCases = (
  binding: Parameter | Variable,
  match: Match
): MatchCase[] => {
  return match.cases.map((c) => {
    const type = getExprType(c.matchTypeExpr);

    if (!type?.isObjectType()) {
      throw new Error(
        `Match case types must be object types at ${type?.location}`
      );
    }

    const caseExpr = resolveTypes(c.expr);
    const expr =
      caseExpr?.isCall() || caseExpr?.isBlock()
        ? caseExpr
        : new Block({ body: [caseExpr] });

    const localBinding = binding.clone();
    localBinding.type = type;
    expr.registerEntity(localBinding);

    return { matchType: type, expr, matchTypeExpr: c.matchTypeExpr };
  });
};

const getBinding = (match: Match): Parameter | Variable => {
  if (match.bindVariable) {
    return match.bindVariable;
  }

  const binding = match.bindIdentifier.resolve();

  if (!(binding?.isVariable() || binding?.isParameter())) {
    throw new Error(`Match binding must be a variable or parameter`);
  }

  return binding;
};
