import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
} from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import type { HirExprId } from "../ids.js";
import type { HirObjectLiteralEntry } from "../hir/index.js";
import type { LowerObjectLiteralOptions } from "../types.js";
import type { LoweringFormParams, LoweringParams } from "./types.js";

export const isObjectLiteralForm = (form: Form): boolean =>
  form.callsInternal("object_literal");

export const lowerObjectLiteralExpr = ({
  form,
  ctx,
  scopes,
  lowerExpr,
  options = {},
}: LoweringFormParams & { options?: LowerObjectLiteralOptions }): HirExprId => {
  const entries = form.rest.map((entry) =>
    lowerObjectLiteralEntry({ entry, ctx, scopes, lowerExpr })
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
}: LoweringParams & { entry: Expr | undefined }): HirObjectLiteralEntry => {
  if (!entry) {
    throw new Error("object literal entry missing expression");
  }

  if (isForm(entry) && entry.calls("...")) {
    const valueExpr = entry.at(1);
    if (!valueExpr) {
      throw new Error("spread entry missing value");
    }
    return {
      kind: "spread",
      value: lowerExpr(valueExpr, ctx, scopes),
      span: toSourceSpan(entry),
    };
  }

  if (isForm(entry) && entry.calls(":")) {
    const nameExpr = entry.at(1);
    if (!isIdentifierAtom(nameExpr)) {
      throw new Error("object literal field name must be an identifier");
    }
    const valueExpr = entry.at(2);
    if (!valueExpr) {
      throw new Error("object literal field missing value");
    }
    return {
      kind: "field",
      name: nameExpr.value,
      value: lowerExpr(valueExpr, ctx, scopes),
      span: toSourceSpan(entry),
    };
  }

  if (isIdentifierAtom(entry)) {
    return {
      kind: "field",
      name: entry.value,
      value: lowerExpr(entry, ctx, scopes),
      span: toSourceSpan(entry),
    };
  }

  throw new Error("unsupported object literal entry");
};
