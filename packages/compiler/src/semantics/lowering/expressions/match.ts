import {
  type Expr,
  Form,
  type Syntax,
  isForm,
  isIdentifierAtom,
} from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import type { HirExprId } from "../../ids.js";
import type { HirMatchArm, HirPattern } from "../../hir/index.js";
import { resolveSymbol } from "../resolution.js";
import { lowerTypeExpr } from "../type-expressions.js";
import { lowerPattern } from "./patterns.js";
import type { LoweringFormParams } from "./types.js";

type LowerMatchParams = LoweringFormParams & {
  operandOverride?: Expr;
};

export const lowerMatch = ({
  form,
  ctx,
  scopes,
  lowerExpr,
  operandOverride,
}: LowerMatchParams): HirExprId => {
  const scopeId = ctx.scopeByNode.get(form.syntaxId);
  if (scopeId !== undefined) {
    scopes.push(scopeId);
  }

  const operandExpr = operandOverride ?? form.at(1);
  if (!operandExpr) {
    throw new Error("match expression missing discriminant");
  }

  const potentialBinder = operandOverride ? form.at(1) : form.at(2);
  const hasBinder = isIdentifierAtom(potentialBinder);
  const caseStart = hasBinder
    ? operandOverride
      ? 2
      : 3
    : operandOverride
    ? 1
    : 2;

  const operandId = lowerExpr(operandExpr, ctx, scopes);
  const binderSymbol =
    hasBinder && potentialBinder
      ? resolveSymbol(potentialBinder.value, scopes.current(), ctx)
      : undefined;

  const arms: HirMatchArm[] = form
    .toArray()
    .slice(caseStart)
    .map((entry) =>
      lowerMatchArm({
        entry,
        ctx,
        scopes,
        lowerExpr,
      })
    );

  const discriminant =
    typeof binderSymbol === "number"
      ? ctx.builder.addExpression({
          kind: "expr",
          exprKind: "identifier",
          ast:
            (potentialBinder as Syntax | undefined)?.syntaxId ?? form.syntaxId,
          span: toSourceSpan((potentialBinder as Syntax | undefined) ?? form),
          symbol: binderSymbol,
        })
      : operandId;

  const matchExpr = ctx.builder.addExpression({
    kind: "expr",
    exprKind: "match",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    discriminant,
    arms,
  });

  if (scopeId !== undefined) {
    scopes.pop();
  }

  if (typeof binderSymbol === "number") {
    const binderPattern: HirPattern = {
      kind: "identifier",
      symbol: binderSymbol,
      span: toSourceSpan((potentialBinder as Syntax | undefined) ?? form),
    };
    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "block",
      ast: form.syntaxId,
      span: toSourceSpan(form),
      statements: [
        ctx.builder.addStatement({
          kind: "let",
          ast:
            (potentialBinder as Syntax | undefined)?.syntaxId ?? form.syntaxId,
          span: toSourceSpan((potentialBinder as Syntax | undefined) ?? form),
          mutable: false,
          pattern: binderPattern,
          initializer: operandId,
        }),
      ],
      value: matchExpr,
    });
  }

  return matchExpr;
};

const lowerMatchArm = ({
  entry,
  ctx,
  scopes,
  lowerExpr,
}: {
  entry: Expr | undefined;
  ctx: LowerMatchParams["ctx"];
  scopes: LowerMatchParams["scopes"];
  lowerExpr: LowerMatchParams["lowerExpr"];
}): HirMatchArm => {
  if (!isForm(entry) || !entry.calls(":")) {
    throw new Error("match cases must be labeled with ':'");
  }

  const scopeId = ctx.scopeByNode.get(entry.syntaxId);
  if (scopeId !== undefined) {
    scopes.push(scopeId);
  }

  const patternExpr = entry.at(1);
  const valueExpr = entry.at(2);
  if (!valueExpr) {
    throw new Error("match case missing value expression");
  }

  const pattern = lowerMatchPattern(patternExpr, ctx, scopes);
  const value = lowerExpr(valueExpr, ctx, scopes);

  if (scopeId !== undefined) {
    scopes.pop();
  }

  return { pattern, value };
};

const lowerMatchPattern = (
  pattern: Expr | undefined,
  ctx: LowerMatchParams["ctx"],
  scopes: LowerMatchParams["scopes"]
): HirPattern => {
  if (!pattern) {
    throw new Error("match case missing pattern");
  }

  if (isIdentifierAtom(pattern)) {
    if (pattern.value === "_" || pattern.value === "else") {
      return { kind: "wildcard", span: toSourceSpan(pattern) };
    }
    const type = lowerTypeExpr(pattern, ctx, scopes.current());
    if (!type) {
      throw new Error("match pattern missing type");
    }
    return { kind: "type", type, span: toSourceSpan(pattern) };
  }

  if (isForm(pattern) && pattern.calls("as")) {
    const base = pattern.at(1);
    const binding = pattern.at(2);
    if (!base || !binding) {
      throw new Error("match pattern 'as' is missing a target or binding");
    }

    const type = lowerTypeExpr(base, ctx, scopes.current());
    if (!type) {
      throw new Error("match pattern 'as' requires a type on the left");
    }

    return {
      kind: "type",
      type,
      binding: lowerPattern(binding, ctx, scopes),
      span: toSourceSpan(pattern),
    };
  }

  if (isForm(pattern)) {
    if (pattern.calls("tuple") || pattern.callsInternal("tuple")) {
      return lowerPattern(pattern, ctx, scopes);
    }

    const last = pattern.at(-1);
    if (isForm(last) && last.callsInternal("object_literal")) {
      const headElements = pattern.toArray().slice(0, -1);
      const headExpr =
        headElements.length === 1 ? headElements[0]! : new Form(headElements);
      const type = lowerTypeExpr(headExpr, ctx, scopes.current());
      if (!type) {
        throw new Error("match destructure pattern is missing a type");
      }
      return {
        kind: "type",
        type,
        binding: lowerPattern(last, ctx, scopes),
        span: toSourceSpan(pattern),
      };
    }
  }

  const type = lowerTypeExpr(pattern, ctx, scopes.current());
  if (type) {
    return { kind: "type", type, span: toSourceSpan(pattern) };
  }

  throw new Error("unsupported match pattern");
};
