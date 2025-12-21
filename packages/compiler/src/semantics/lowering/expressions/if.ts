import {
  type Form,
  isForm,
  isIdentifierAtom,
} from "../../../parser/index.js";
import { parseIfBranches } from "../../utils.js";
import type { HirCondBranch, HirMatchArm, HirPattern } from "../../hir/index.js";
import type { HirExprId } from "../../ids.js";
import { toSourceSpan } from "../../utils.js";
import { lowerTypeExpr } from "../type-expressions.js";
import type { LoweringFormParams } from "./types.js";

export const lowerIf = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const matchShorthand = tryLowerIfAsMatch({ form, ctx, scopes, lowerExpr });
  if (typeof matchShorthand === "number") {
    return matchShorthand;
  }

  const { branches, defaultBranch } = parseIfBranches(form);
  const loweredBranches: HirCondBranch[] = branches.map(
    ({ condition, value }) => ({
      condition: lowerExpr(condition, ctx, scopes),
      value: lowerExpr(value, ctx, scopes),
    })
  );

  const loweredDefault = defaultBranch
    ? lowerExpr(defaultBranch, ctx, scopes)
    : undefined;

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "if",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    branches: loweredBranches,
    defaultBranch: loweredDefault,
  });
};

const tryLowerIfAsMatch = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId | undefined => {
  const { branches, defaultBranch } = parseIfBranches(form);
  if (!defaultBranch) {
    return;
  }

  const firstCondition = branches.at(0)?.condition;
  if (!isForm(firstCondition) || !firstCondition.calls("is")) {
    return;
  }

  const discriminantExpr = firstCondition.at(1);
  if (!isIdentifierAtom(discriminantExpr)) {
    return;
  }
  const discriminantName = discriminantExpr.value;

  const discriminant = lowerExpr(discriminantExpr, ctx, scopes);
  const arms: HirMatchArm[] = [];

  for (const branch of branches) {
    const condition = branch.condition;
    if (!isForm(condition) || !condition.calls("is")) {
      return;
    }

    const left = condition.at(1);
    const right = condition.at(2);
    if (!isIdentifierAtom(left) || left.value !== discriminantName || !right) {
      return;
    }

    const type = lowerTypeExpr(right, ctx, scopes.current());
    if (!type) {
      return;
    }

    const pattern: HirPattern = {
      kind: "type",
      type,
      span: toSourceSpan(condition),
    };

    arms.push({
      pattern,
      value: lowerExpr(branch.value, ctx, scopes),
    });
  }

  arms.push({
    pattern: { kind: "wildcard", span: toSourceSpan(form) },
    value: lowerExpr(defaultBranch, ctx, scopes),
  });

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "match",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    discriminant,
    arms,
  });
};
