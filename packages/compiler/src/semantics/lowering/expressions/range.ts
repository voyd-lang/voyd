import {
  call,
  type Expr,
  Form,
  type IdentifierAtom,
  identifier,
  isForm,
  isIdentifierAtom,
} from "../../../parser/index.js";
import type { HirExprId, SymbolId } from "../../ids.js";
import type { HirNamedTypeExpr, HirObjectLiteralEntry } from "../../hir/index.js";
import { toSourceSpan } from "../../utils.js";
import { resolveTypeSymbol } from "../resolution.js";
import type {
  LowerExprFn,
  LoweringFormParams,
  LoweringParams,
} from "./types.js";

const RANGE_OPERATOR_NAMES = new Set(["..", "..=", "..<"]);

type RangeBounds = {
  start?: Expr;
  end?: Expr;
  includeEnd: boolean;
};

export const isRangeOperatorAtom = (
  expr: Expr | undefined
): expr is IdentifierAtom =>
  isIdentifierAtom(expr) && RANGE_OPERATOR_NAMES.has(expr.value);

export const isRangeExprForm = (expr: Expr): boolean =>
  isForm(expr) && isRangeOperatorAtom(expr.at(0));

export const lowerRangeOperatorExpr = ({
  operator,
  ctx,
  scopes,
  lowerExpr,
}: LoweringParams & {
  operator: IdentifierAtom;
  lowerExpr: LowerExprFn;
}): HirExprId =>
  lowerRangeFromBounds({
    syntax: operator,
    bounds: {
      includeEnd: operator.value === "..=",
    },
    ctx,
    scopes,
    lowerExpr,
  });

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
  return lowerRangeFromBounds({
    syntax: form,
    bounds,
    ctx,
    scopes,
    lowerExpr,
  });
};

const lowerRangeFromBounds = ({
  syntax,
  bounds,
  ctx,
  scopes,
  lowerExpr,
}: LoweringParams & {
  syntax: Expr;
  bounds: RangeBounds;
  lowerExpr: LowerExprFn;
}): HirExprId => {
  const rangeSymbol = resolveTypeSymbol("Range", scopes.current(), ctx);
  const target = createRangeTarget({
    syntax,
    rangeSymbol,
  });
  const entries = createRangeEntries({
    syntax,
    bounds,
    ctx,
    scopes,
    lowerExpr,
  });

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "object-literal",
    ast: syntax.syntaxId,
    span: toSourceSpan(syntax),
    literalKind: "nominal",
    target,
    targetSymbol: rangeSymbol,
    entries,
  });
};

const createRangeTarget = ({
  syntax,
  rangeSymbol,
}: {
  syntax: Expr;
  rangeSymbol?: SymbolId;
}): HirNamedTypeExpr => ({
  typeKind: "named",
  path: ["Range"],
  ast: syntax.syntaxId,
  span: toSourceSpan(syntax),
  ...(typeof rangeSymbol === "number" ? { symbol: rangeSymbol } : {}),
});

const createRangeEntries = ({
  syntax,
  bounds,
  ctx,
  scopes,
  lowerExpr,
}: LoweringParams & {
  syntax: Expr;
  bounds: RangeBounds;
  lowerExpr: LowerExprFn;
}): HirObjectLiteralEntry[] => {
  const entries: HirObjectLiteralEntry[] = [
    {
      kind: "field",
      name: "start",
      value: lowerExpr(createOptionalBoundExpr(bounds.start, syntax), ctx, scopes),
      span: toSourceSpan(bounds.start ?? syntax),
    },
    {
      kind: "field",
      name: "end",
      value: lowerExpr(createOptionalBoundExpr(bounds.end, syntax), ctx, scopes),
      span: toSourceSpan(bounds.end ?? syntax),
    },
  ];

  const includeEndExpr = ctx.builder.addExpression({
    kind: "expr",
    exprKind: "literal",
    ast: syntax.syntaxId,
    span: toSourceSpan(syntax),
    literalKind: "boolean",
    value: bounds.includeEnd ? "true" : "false",
  });
  entries.push({
    kind: "field",
    name: "include_end",
    value: includeEndExpr,
    span: toSourceSpan(syntax),
  });

  return entries;
};

const parseRangeBounds = (form: Form): RangeBounds | undefined => {
  const op = form.at(0);
  if (!isRangeOperatorAtom(op)) {
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

const isEmptyExpr = (expr: Expr | undefined): expr is Form =>
  isForm(expr) && expr.length === 0;

const createOptionalBoundExpr = (
  bound: Expr | undefined,
  fallbackLocation: Expr
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
