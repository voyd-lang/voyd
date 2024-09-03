import { Block } from "../../syntax-objects/block.js";
import { Call, Parameter, Variable } from "../../syntax-objects/index.js";
import { Match, MatchCase } from "../../syntax-objects/match.js";
import { getExprType } from "./get-expr-type.js";
import { resolveTypes } from "./resolve-types.js";

export const resolveMatch = (match: Match): Match => {
  match.operand = resolveTypes(match.operand);
  match.baseType = getExprType(match.operand);

  const binding = getBinding(match);
  resolveCases(binding, match);
  match.type = (match.defaultCase?.expr ?? match.cases[0].expr).type;

  return match;
};

const resolveCases = (binding: Parameter | Variable, match: Match) => {
  match.cases = match.cases.map((c) => resolveCase(binding, c));
  match.defaultCase = match.defaultCase
    ? resolveCase(binding, match.defaultCase)
    : undefined;
};

const resolveCase = (
  binding: Parameter | Variable,
  c: MatchCase
): MatchCase => {
  const type = getExprType(c.matchTypeExpr);

  const localBinding = binding.clone();
  localBinding.originalType = localBinding.type;
  localBinding.type = type;
  localBinding.requiresCast = true;
  c.expr.registerEntity(localBinding);

  const expr = resolveTypes(c.expr) as Call | Block;

  return {
    matchType: type?.isObjectType() ? type : undefined,
    expr,
    matchTypeExpr: c.matchTypeExpr,
  };
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
