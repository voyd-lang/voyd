import { Block } from "../../syntax-objects/block.js";
import { Call, Parameter, Type, Variable } from "../../syntax-objects/index.js";
import { Match, MatchCase } from "../../syntax-objects/match.js";
import { combineTypes } from "./combine-types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveEntities, resolveVar } from "./resolve-entities.js";

export const resolveMatch = (match: Match): Match => {
  match.operand = resolveEntities(match.operand);
  match.baseType = getExprType(match.operand);

  const binding = getBinding(match);
  resolveCases(binding, match);
  match.type = resolveMatchReturnType(match);

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
  localBinding.originalType = binding.type;
  localBinding.type = type;
  localBinding.requiresCast = true;

  // NOTE: This binding is temporary and will be overwritten in the next case.
  // We may need to introduce an wrapping block and register it to the blocks scope
  // to avoid this.
  c.expr.registerEntity(localBinding);

  const expr = resolveEntities(c.expr) as Call | Block;

  return {
    matchType: type?.isObjectType() ? type : undefined,
    expr,
    matchTypeExpr: c.matchTypeExpr,
  };
};

const getBinding = (match: Match): Parameter | Variable => {
  if (match.bindVariable) {
    return resolveVar(match.bindVariable);
  }

  const binding = match.bindIdentifier.resolve();

  if (!(binding?.isVariable() || binding?.isParameter())) {
    throw new Error(`Match binding must be a variable or parameter`);
  }

  return binding;
};

const resolveMatchReturnType = (match: Match): Type | undefined => {
  const cases = match.cases
    .map((c) => c.expr.type)
    .concat(match.defaultCase?.expr.type)
    .filter((t) => t !== undefined);

  return combineTypes(cases);
};
