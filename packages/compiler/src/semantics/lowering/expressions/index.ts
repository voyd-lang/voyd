import {
  type Expr,
  type IdentifierAtom,
  type InternalIdentifierAtom,
  type Syntax,
  isBoolAtom,
  isFloatAtom,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
  isIntAtom,
  isStringAtom,
} from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import { resolveIdentifierValue } from "../resolution.js";
import type { HirExprId } from "../../ids.js";
import type { LowerContext, LowerScopeStack } from "../types.js";
import { lowerAssignment } from "./assignment.js";
import { lowerArrayLiteralExpr, isArrayLiteralForm } from "./array-literal.js";
import { lowerBlock } from "./block.js";
import { lowerCall } from "./call.js";
import { lowerDotExpr } from "./dot.js";
import { lowerFieldAccessExpr, isFieldAccessForm } from "./field-access.js";
import { lowerIf } from "./if.js";
import { lowerLambda } from "./lambda.js";
import { lowerMatch } from "./match.js";
import { lowerTry } from "./try.js";
import {
  isObjectLiteralForm,
  lowerObjectLiteralExpr,
} from "./object-literal.js";
import type { LowerExprFn } from "./types.js";
import { lowerStaticAccessExpr } from "./static-access.js";
import { lowerTupleExpr } from "./tuple.js";
import { lowerWhile } from "./while.js";
import { createVoidLiteralExpr } from "./literal-helpers.js";
import {
  isSubscriptForm,
  lowerSubscriptReadExpr,
} from "./subscript.js";
import {
  isRangeExprForm,
  isRangeOperatorAtom,
  lowerRangeExpr,
  lowerRangeOperatorExpr,
} from "./range.js";

export { isObjectLiteralForm } from "./object-literal.js";

const isBreakExpr = (
  expr: Expr
): expr is IdentifierAtom | InternalIdentifierAtom =>
  (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) && expr.value === "break";

const isContinueExpr = (
  expr: Expr
): expr is IdentifierAtom | InternalIdentifierAtom =>
  (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) && expr.value === "continue";

const lowerBreak = ({
  ast,
  label,
  value,
  ctx,
  scopes,
  lowerExpr,
}: {
  ast: Syntax;
  label?: string;
  value?: Expr;
  ctx: LowerContext;
  scopes: LowerScopeStack;
  lowerExpr: LowerExprFn;
}): HirExprId => {
  const loweredValue = value ? lowerExpr(value, ctx, scopes) : undefined;
  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "break",
    ast: ast.syntaxId,
    span: toSourceSpan(ast),
    label,
    value: loweredValue,
  });
};

const lowerContinue = ({
  ast,
  label,
  ctx,
}: {
  ast: Syntax;
  label?: string;
  ctx: LowerContext;
}): HirExprId =>
  ctx.builder.addExpression({
    kind: "expr",
    exprKind: "continue",
    ast: ast.syntaxId,
    span: toSourceSpan(ast),
    label,
  });

export const lowerExpr: LowerExprFn = (
  expr: Expr | undefined,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirExprId => {
  if (!expr) {
    throw new Error("expected expression");
  }

  if (isIntAtom(expr)) {
    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "literal",
      ast: expr.syntaxId,
      span: toSourceSpan(expr),
      literalKind: expr.intType,
      value: expr.value,
    });
  }

  if (isFloatAtom(expr)) {
    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "literal",
      ast: expr.syntaxId,
      span: toSourceSpan(expr),
      literalKind: expr.floatType,
      value: expr.value,
    });
  }

  if (isStringAtom(expr)) {
    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "literal",
      ast: expr.syntaxId,
      span: toSourceSpan(expr),
      literalKind: "string",
      value: expr.value,
    });
  }

  if (isBoolAtom(expr)) {
    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "literal",
      ast: expr.syntaxId,
      span: toSourceSpan(expr),
      literalKind: "boolean",
      value: expr.value,
    });
  }

  const identifierAtom =
    isIdentifierAtom(expr)
      ? expr
      : isInternalIdentifierAtom(expr)
        ? expr
        : undefined;

  if (identifierAtom) {
    if (isBreakExpr(expr)) {
      return lowerBreak({ ast: expr, ctx, scopes, lowerExpr });
    }
    if (isContinueExpr(expr)) {
      return lowerContinue({ ast: expr, ctx });
    }
    if (identifierAtom.value === "void") {
      return createVoidLiteralExpr(expr, ctx);
    }
    if (isRangeOperatorAtom(identifierAtom)) {
      return lowerRangeOperatorExpr({
        operator: identifierAtom,
        ctx,
        scopes,
        lowerExpr,
      });
    }
    const resolution = resolveIdentifierValue(
      {
        name: identifierAtom.value,
        isQuoted: isIdentifierAtom(identifierAtom) ? identifierAtom.isQuoted : false,
      },
      scopes.current(),
      ctx
    );
    if (resolution.kind === "symbol") {
      return ctx.builder.addExpression({
        kind: "expr",
        exprKind: "identifier",
        ast: identifierAtom.syntaxId,
        span: toSourceSpan(identifierAtom),
        symbol: resolution.symbol,
      });
    }

    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "overload-set",
      ast: identifierAtom.syntaxId,
      span: toSourceSpan(identifierAtom),
      name: resolution.name,
      set: resolution.set,
    });
  }

  if (isForm(expr)) {
    if (
      isIdentifierAtom(expr.first) &&
      (expr.first.value === "break" || expr.first.value === "continue")
    ) {
      const label =
        expr.length >= 3 && isIdentifierAtom(expr.at(1))
          ? (expr.at(1) as { value: string }).value
          : undefined;
      if (expr.first.value === "continue") {
        return lowerContinue({ ast: expr, label, ctx });
      }
      const valueExpr =
        expr.length === 2
          ? expr.at(1)
          : expr.length >= 3 && label
            ? expr.at(2)
            : undefined;
      return lowerBreak({
        ast: expr,
        label,
        value: valueExpr,
        ctx,
        scopes,
        lowerExpr,
      });
    }
    if (isObjectLiteralForm(expr)) {
      return lowerObjectLiteralExpr({ form: expr, ctx, scopes, lowerExpr });
    }

    if (isArrayLiteralForm(expr)) {
      return lowerArrayLiteralExpr({ form: expr, ctx, scopes, lowerExpr });
    }

    if (isSubscriptForm(expr)) {
      return lowerSubscriptReadExpr({ form: expr, ctx, scopes, lowerExpr });
    }

    if (isRangeExprForm(expr)) {
      return lowerRangeExpr({ form: expr, ctx, scopes, lowerExpr });
    }

    if (expr.calls("match")) {
      return lowerMatch({ form: expr, ctx, scopes, lowerExpr });
    }

    if (expr.calls("try")) {
      return lowerTry({ form: expr, ctx, scopes, lowerExpr });
    }

    if (isFieldAccessForm(expr)) {
      return lowerFieldAccessExpr({ form: expr, ctx, scopes, lowerExpr });
    }

    if (expr.calls("::")) {
      return lowerStaticAccessExpr({ form: expr, ctx, scopes, lowerExpr });
    }

    if (expr.calls(".")) {
      return lowerDotExpr({ form: expr, ctx, scopes, lowerExpr });
    }

    if (expr.calls("block")) {
      return lowerBlock({ form: expr, ctx, scopes, lowerExpr });
    }

    if (expr.calls("if")) {
      return lowerIf({ form: expr, ctx, scopes, lowerExpr });
    }

    if (expr.calls("while")) {
      return lowerWhile({ form: expr, ctx, scopes, lowerExpr });
    }

    if (expr.calls("=>")) {
      return lowerLambda({ form: expr, ctx, scopes, lowerExpr });
    }

    if (expr.calls("tuple") || expr.callsInternal("tuple")) {
      return lowerTupleExpr({ form: expr, ctx, scopes, lowerExpr });
    }

    if (expr.calls("=")) {
      return lowerAssignment({ form: expr, ctx, scopes, lowerExpr });
    }

    return lowerCall({ form: expr, ctx, scopes, lowerExpr });
  }

  throw new Error(`unsupported expression node: ${expr.location}`);
};
