import {
  call,
  type Expr,
  Form,
  type IdentifierAtom,
  identifier,
  isForm,
  isIdentifierAtom,
} from "../../../parser/index.js";
import type { HirExprId } from "../../ids.js";
import type { HirObjectLiteralEntry } from "../../hir/index.js";
import { toSourceSpan } from "../../utils.js";
import type { LoweringFormParams, LoweringParams } from "./types.js";

const RANGE_OPERATOR_NAMES = new Set(["..", "..=", "..<"]);

export const isSubscriptForm = (form: Form): boolean =>
  form.callsInternal("subscript");

export const isRangeExprForm = (expr: Expr): boolean =>
  isForm(expr) && isRangeOperator(expr.at(0));

export const lowerSubscriptReadExpr = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const receiverExpr = form.at(1);
  const indexExpr = form.at(2);
  if (!receiverExpr || !indexExpr) {
    throw new Error("subscript expression requires receiver and index");
  }

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "method-call",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    target: lowerExpr(receiverExpr, ctx, scopes),
    method: "subscript_get",
    args: [{ expr: lowerExpr(indexExpr, ctx, scopes) }],
  });
};

export const lowerSubscriptSetExpr = ({
  assignmentForm,
  targetForm,
  valueExpr,
  ctx,
  scopes,
  lowerExpr,
}: LoweringParams & {
  assignmentForm: Form;
  targetForm: Form;
  valueExpr: Expr;
}): HirExprId => {
  const receiverExpr = targetForm.at(1);
  const indexExpr = targetForm.at(2);
  if (!receiverExpr || !indexExpr) {
    throw new Error("subscript assignment requires receiver and index");
  }

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "method-call",
    ast: assignmentForm.syntaxId,
    span: toSourceSpan(assignmentForm),
    target: lowerExpr(receiverExpr, ctx, scopes),
    method: "subscript_set",
    args: [
      { expr: lowerExpr(indexExpr, ctx, scopes) },
      { expr: lowerExpr(valueExpr, ctx, scopes) },
    ],
  });
};

export const lowerRangeExpr = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const bounds = parseRangeBounds(form);
  if (!bounds) {
    throw new Error("invalid range expression");
  }

  const entries = createRangeEntries({
    form,
    bounds,
    ctx,
    scopes,
    lowerExpr,
  });

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "object-literal",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    literalKind: "structural",
    entries,
  });
};

const createRangeEntries = ({
  form,
  bounds,
  ctx,
  scopes,
  lowerExpr,
}: LoweringParams & {
  form: Form;
  bounds: RangeBounds;
}): HirObjectLiteralEntry[] => {
  const entries: HirObjectLiteralEntry[] = [
    {
      kind: "field",
      name: "start",
      value: lowerExpr(createOptionalBoundExpr(bounds.start, form), ctx, scopes),
      span: toSourceSpan(bounds.start ?? form),
    },
    {
      kind: "field",
      name: "end",
      value: lowerExpr(createOptionalBoundExpr(bounds.end, form), ctx, scopes),
      span: toSourceSpan(bounds.end ?? form),
    },
  ];

  const includeEndExpr = ctx.builder.addExpression({
    kind: "expr",
    exprKind: "literal",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    literalKind: "boolean",
    value: bounds.includeEnd ? "true" : "false",
  });
  entries.push({
    kind: "field",
    name: "include_end",
    value: includeEndExpr,
    span: toSourceSpan(form),
  });

  return entries;
};

type RangeBounds = {
  start?: Expr;
  end?: Expr;
  includeEnd: boolean;
};

const parseRangeBounds = (form: Form): RangeBounds | undefined => {
  const op = form.at(0);
  if (!isRangeOperator(op)) {
    return undefined;
  }

  const includeEnd = op.value === "..=";
  const first = form.at(1);
  const second = form.at(2);

  if (isEmptyExpr(second)) {
    if (isEmptyExpr(first)) {
      return { includeEnd };
    }
    return { start: first, includeEnd };
  }

  if (!second) {
    if (!first || isEmptyExpr(first)) {
      return { includeEnd };
    }
    return { end: first, includeEnd };
  }

  if (!first || isEmptyExpr(first)) {
    return { end: second, includeEnd };
  }

  return { start: first, end: second, includeEnd };
};

const isRangeOperator = (
  expr: Expr | undefined
): expr is IdentifierAtom =>
  isIdentifierAtom(expr) && RANGE_OPERATOR_NAMES.has(expr.value);

const isEmptyExpr = (expr: Expr | undefined): expr is Form =>
  isForm(expr) && expr.length === 0;

const createOptionalBoundExpr = (
  bound: Expr | undefined,
  fallbackLocation: Form
): Expr => {
  if (bound) {
    return new Form([identifier("some"), bound]).setLocation(
      bound.location?.clone() ?? fallbackLocation.location?.clone()
    );
  }

  return new Form([identifier("none"), call("generics", identifier("i32"))]).setLocation(
    fallbackLocation.location?.clone()
  );
};
