import { type Expr } from "../../../parser/index.js";
import { toSourceSpan } from "../../../parser/surface/utils.js";
import type { HirExprId } from "../../ids.js";
import type { HirMatchArm, HirPattern } from "../../hir/index.js";
import { resolveSymbol } from "../resolution.js";
import { lowerTypeExpr } from "../type-expressions.js";
import { lowerSurfacePattern } from "./patterns.js";
import type { LoweringFormParams } from "./types.js";
import {
  parseSurfaceMatchExpression,
  type SurfaceMatchExpression,
  type SurfaceMatchPattern,
} from "../../../parser/surface/index.js";

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

  const match = parseSurfaceMatchExpression(form, operandOverride);
  const operandId = lowerExpr(match.operand, ctx, scopes);
  const binderSymbol = match.binder
    ? resolveSymbol(match.binder.value, scopes.current(), ctx)
    : undefined;

  const arms: HirMatchArm[] = match.arms.map((arm) =>
    lowerMatchArm({
      arm,
      ctx,
      scopes,
      lowerExpr,
    }),
  );

  const discriminant =
    typeof binderSymbol === "number" && match.binder
      ? ctx.builder.addExpression({
          kind: "expr",
          exprKind: "identifier",
          ast: match.binder.syntaxId,
          span: toSourceSpan(match.binder),
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

  if (typeof binderSymbol === "number" && match.binder) {
    const binderPattern: HirPattern = {
      kind: "identifier",
      symbol: binderSymbol,
      span: toSourceSpan(match.binder),
    };
    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "block",
      ast: form.syntaxId,
      span: toSourceSpan(form),
      statements: [
        ctx.builder.addStatement({
          kind: "let",
          ast: match.binder.syntaxId,
          span: toSourceSpan(match.binder),
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
  arm,
  ctx,
  scopes,
  lowerExpr,
}: {
  arm: SurfaceMatchExpression["arms"][number];
  ctx: LowerMatchParams["ctx"];
  scopes: LowerMatchParams["scopes"];
  lowerExpr: LowerMatchParams["lowerExpr"];
}): HirMatchArm => {
  const scopeId = ctx.scopeByNode.get(arm.form.syntaxId);
  if (scopeId !== undefined) {
    scopes.push(scopeId);
  }

  const pattern = lowerMatchPattern(arm.pattern, ctx, scopes);
  const value = lowerExpr(arm.value, ctx, scopes);

  if (scopeId !== undefined) {
    scopes.pop();
  }

  return { pattern, value };
};

const lowerMatchPattern = (
  pattern: SurfaceMatchPattern,
  ctx: LowerMatchParams["ctx"],
  scopes: LowerMatchParams["scopes"],
): HirPattern => {
  if (pattern.kind === "wildcard") {
    return { kind: "wildcard", span: toSourceSpan(pattern.syntax) };
  }
  if (pattern.kind === "tuple") {
    return lowerSurfacePattern(pattern.binding, ctx, scopes);
  }
  const type = lowerTypeExpr(pattern.typeExpr, ctx, scopes.current());
  if (!type) {
    throw new Error("match pattern is missing a type");
  }
  if (pattern.kind === "type-binding" || pattern.kind === "destructure") {
    if (!type) {
      throw new Error("match pattern requires a type");
    }
    return {
      kind: "type",
      type,
      binding: lowerSurfacePattern(pattern.binding, ctx, scopes),
      span: toSourceSpan(pattern.syntax),
    };
  }
  return { kind: "type", type, span: toSourceSpan(pattern.syntax) };
};
