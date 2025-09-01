import { Block } from "../../syntax-objects/block.js";
import { Call, Parameter, Type, Variable } from "../../syntax-objects/index.js";
import { Match, MatchCase } from "../../syntax-objects/match.js";
import { combineTypes } from "./combine-types.js";
import { getExprType } from "./get-expr-type.js";
import { resolveEntities, resolveVar } from "./resolve-entities.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { UnionType, ObjectType } from "../../syntax-objects/types.js";
import { resolveUnionType } from "./resolve-union.js";

export const resolveMatch = (match: Match): Match => {
  match.operand = resolveEntities(match.operand);
  match.baseType = getExprType(match.operand);

  // Allow omission of generic type parameters in match arms when the
  // referenced object appears exactly once within the matched union. For
  // example, matching Optional<T> permits writing `Some:` instead of
  // `Some<T>`.
  maybeFillOmittedCaseTypes(match);

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
  if (c.matchTypeExpr) resolveTypeExpr(c.matchTypeExpr);
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
    matchType: type?.isRefType() ? type : undefined,
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

// Helpers
const typeHead = (t?: Type): string | undefined => {
  if (!t) return undefined;
  if (t.isObjectType()) {
    const obj = t as ObjectType;
    return obj.genericParent ? obj.genericParent.name.value : obj.name.value;
  }
  return t.name.value;
};

// If matching against a union, allow cases like `Some:` (without type
// parameters) when the head appears exactly once in the union. Replace the
// case's type expression with the unique union member to make it concrete.
const maybeFillOmittedCaseTypes = (match: Match) => {
  const base = match.baseType;
  if (!base?.isUnionType()) return;
  const union = resolveUnionType(base as UnionType);
  if (!union.types.length) return;

  const headMap = new Map<string, ObjectType[]>();
  for (const t of union.types) {
    if (!t.isObjectType()) continue;
    const key = typeHead(t);
    if (!key) continue;
    const arr = headMap.get(key) ?? [];
    arr.push(t as ObjectType);
    headMap.set(key, arr);
  }

  const fill = (c: MatchCase | undefined) => {
    if (!c?.matchTypeExpr) return;
    // Only fill when user omitted type args (Identifier case). If it's a
    // concrete Type or a Call with explicit args, leave it as-is.
    const e = c.matchTypeExpr;
    if (e.isType()) return;
    if (e.isCall()) return; // explicit generic provided
    if (!e.isIdentifier()) return;
    const key = e.value;
    const candidates = headMap.get(key) ?? [];
    if (candidates.length !== 1) return; // ambiguous or missing
    c.matchTypeExpr = candidates[0]!; // use the concrete union member type
  };

  match.cases.forEach(fill);
  if (match.defaultCase) fill(match.defaultCase);
};
