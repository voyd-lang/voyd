import type { Expr, Form } from "../../../parser/index.js";
import { toSourceSpan } from "../../../parser/surface/utils.js";
import type { HirExprId, SymbolId } from "../../ids.js";
import type { HirObjectLiteralEntry, HirTypeExpr } from "../../hir/index.js";
import type { LowerObjectLiteralOptions } from "../types.js";
import type { LoweringFormParams, LoweringParams } from "./types.js";
import {
  parseSurfaceCallArguments,
  parseValueBraceEntries,
  type SurfaceValueBraceEntry,
} from "../../../parser/surface/index.js";

export const isObjectLiteralForm = (form: Form): boolean =>
  form.callsInternal("object_literal");

export const lowerObjectLiteralExpr = ({
  form,
  ctx,
  scopes,
  lowerExpr,
  options = {},
}: LoweringFormParams & { options?: LowerObjectLiteralOptions }): HirExprId => {
  const entries = parseValueBraceEntries(form).map((entry) =>
    lowerObjectLiteralEntry({ entry, ctx, scopes, lowerExpr }),
  );
  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "object-literal",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    literalKind: options.literalKind ?? "structural",
    target: options.target,
    targetSymbol: options.targetSymbol,
    entries,
  });
};

export const lowerNominalObjectLiteralCall = ({
  arguments: argumentExprs,
  target,
  targetSymbol,
  ast,
  ctx,
  scopes,
  lowerExpr,
}: LoweringParams & {
  arguments: readonly Expr[];
  target: HirTypeExpr;
  targetSymbol: SymbolId;
  ast: Expr;
}): HirExprId | undefined => {
  const arguments_ = parseSurfaceCallArguments(argumentExprs);
  if (arguments_.some((argument) => !argument.label)) {
    return undefined;
  }

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "object-literal",
    ast: ast.syntaxId,
    span: toSourceSpan(ast),
    literalKind: "nominal",
    target,
    targetSymbol,
    entries: arguments_.map((argument) => ({
      kind: "field" as const,
      name: argument.label!.value,
      value: lowerExpr(argument.value, ctx, scopes),
      span: toSourceSpan(argument.syntax),
    })),
  });
};

const lowerObjectLiteralEntry = ({
  entry,
  ctx,
  scopes,
  lowerExpr,
}: LoweringParams & {
  entry: SurfaceValueBraceEntry;
}): HirObjectLiteralEntry => {
  if (entry.kind === "spread") {
    return {
      kind: "spread",
      value: lowerExpr(entry.value, ctx, scopes),
      span: toSourceSpan(entry.form),
    };
  }
  if (entry.kind === "field") {
    return {
      kind: "field",
      name: entry.name.value,
      value: lowerExpr(entry.value, ctx, scopes),
      span: toSourceSpan(entry.form),
    };
  }
  return {
    kind: "field",
    name: entry.name.value,
    value: lowerExpr(entry.value, ctx, scopes),
    span: toSourceSpan(entry.name),
  };
};
