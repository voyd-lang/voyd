import {
  type Expr,
  type Form,
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
import type { HirExprId } from "../ids.js";
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
import {
  isObjectLiteralForm,
  lowerObjectLiteralExpr,
} from "./object-literal.js";
import type { LowerExprFn } from "./types.js";
import { lowerStaticAccessExpr } from "./static-access.js";
import { lowerTupleExpr } from "./tuple.js";
import { lowerWhile } from "./while.js";

export { isObjectLiteralForm } from "./object-literal.js";

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

  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    const resolution = resolveIdentifierValue(
      expr.value,
      scopes.current(),
      ctx
    );
    if (resolution.kind === "symbol") {
      return ctx.builder.addExpression({
        kind: "expr",
        exprKind: "identifier",
        ast: expr.syntaxId,
        span: toSourceSpan(expr),
        symbol: resolution.symbol,
      });
    }

    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "overload-set",
      ast: expr.syntaxId,
      span: toSourceSpan(expr),
      name: resolution.name,
      set: resolution.set,
    });
  }

  if (isForm(expr)) {
    if (isObjectLiteralForm(expr)) {
      return lowerObjectLiteralExpr({ form: expr, ctx, scopes, lowerExpr });
    }

    if (isArrayLiteralForm(expr)) {
      return lowerArrayLiteralExpr({ form: expr, ctx, scopes, lowerExpr });
    }

    if (expr.calls("match")) {
      return lowerMatch({ form: expr, ctx, scopes, lowerExpr });
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
