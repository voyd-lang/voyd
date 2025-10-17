import { Block } from "../../syntax-objects/block.js";
import { Call, Parameter, Type, Variable } from "../../syntax-objects/index.js";
import { Match, MatchCase } from "../../syntax-objects/match.js";
import { combineTypes } from "./combine-types.js";
import { getExprType } from "./get-expr-type.js";
import {
  resolveEntities,
  resolveVar,
  resolveWithExpected,
} from "./resolve-entities.js";
import { resolveTypeExpr } from "./resolve-type-expr.js";
import { UnionType, Obj } from "../../syntax-objects/types.js";
import { resolveUnionType } from "./resolve-union.js";

export const resolveMatch = (match: Match): Match => {
  match.operand = resolveEntities(match.operand);
  match.baseType = getExprType(match.operand);

  // Allow omission of generic type parameters in match arms when the
  // referenced object appears exactly once within the matched union. For
  // example, matching Optional<T> permits writing `Some:` instead of
  // `Some<T>`.
  maybeFillOmittedCaseTypes(match);

  // If this match originated from optional unwrap sugar (Some<T> branch),
  // resolve the default (else) branch against the expected value type T so
  // empty literals (e.g., []) can be typed contextually.
  try {
    const someVariant = findSomeVariant(match.baseType);
    const expectedThenType = someVariant?.getField("value")?.type;
    if (expectedThenType && match.defaultCase?.expr) {
      const def = match.defaultCase.expr;
      if (def.isBlock?.()) {
        const block = def as unknown as Block;
        const n = block.body.length;
        if (n > 0) {
          const last = block.body.at(n - 1)!;
          block.body[n - 1] = resolveWithExpected(last, expectedThenType);
        }
      } else {
        match.defaultCase.expr = new Block({
          ...def.metadata,
          body: [resolveWithExpected(def, expectedThenType)],
        });
      }
    }
  } catch {}

  const binding = getBinding(match);
  resolveCases(binding, match);
  match.type = resolveMatchReturnType(match);

  return match;
};

const resolveCases = (binding: Parameter | Variable, match: Match) => {
  const someVariant = findSomeVariant(match.baseType);
  const expectedThenType = someVariant?.getField("value")?.type;
  match.cases = match.cases.map((c) =>
    resolveCase(binding, c, expectedThenType, false)
  );
  match.defaultCase = match.defaultCase
    ? resolveCase(binding, match.defaultCase, expectedThenType, true)
    : undefined;
};

const resolveCase = (
  binding: Parameter | Variable,
  c: MatchCase,
  expectedDefaultType?: Type,
  isDefault: boolean = false
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

  let expr = c.expr as Call | Block;
  if (isDefault && expectedDefaultType) {
    if (expr.isBlock?.()) {
      const block = expr as unknown as Block;
      const n = block.body.length;
      if (n > 0)
        block.body[n - 1] = resolveWithExpected(
          block.body[n - 1],
          expectedDefaultType
        );
    } else {
      expr = new Block({
        ...expr.metadata,
        body: [resolveWithExpected(expr, expectedDefaultType)],
      });
    }
  }
  expr = resolveEntities(expr) as Call | Block;

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
const findSomeVariant = (type?: Type) => {
  if (!type?.isUnionType()) return undefined;
  return type.resolvedMemberTypes.find(
    (t) => t.isObj() && (t.name.is("Some") || t.genericParent?.name.is("Some"))
  ) as Obj | undefined;
};

const typeHead = (t?: Type): string | undefined => {
  if (!t) return undefined;
  if (t.isObj()) {
    const obj = t as Obj;
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
  if (!union.resolvedMemberTypes.length) return;

  const headMap = new Map<string, Obj[]>();
  for (const t of union.resolvedMemberTypes) {
    if (!t.isObj()) continue;
    const key = typeHead(t);
    if (!key) continue;
    const arr = headMap.get(key) ?? [];
    arr.push(t as Obj);
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
