import type { Form } from "../../../parser/index.js";
import { toSourceSpan } from "../../../parser/surface/utils.js";
import type { HirExprId } from "../../ids.js";
import type { HirObjectLiteralEntry } from "../../hir/index.js";
import type { LowerObjectLiteralOptions } from "../types.js";
import type { LoweringFormParams, LoweringParams } from "./types.js";
import {
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
