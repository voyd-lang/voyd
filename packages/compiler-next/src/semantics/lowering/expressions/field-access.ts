import { type Form, isIdentifierAtom } from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import type { HirExprId } from "../ids.js";
import type { LoweringFormParams } from "./types.js";

export const isFieldAccessForm = (form: Form): boolean => {
  if (!form.calls(".") || form.length !== 3) {
    return false;
  }
  const targetExpr = form.at(1);
  const fieldExpr = form.at(2);
  return !!targetExpr && isIdentifierAtom(fieldExpr);
};

export const lowerFieldAccessExpr = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const targetExpr = form.at(1);
  const fieldExpr = form.at(2);
  if (!targetExpr || !isIdentifierAtom(fieldExpr)) {
    throw new Error("invalid field access expression");
  }
  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "field-access",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    field: fieldExpr.value,
    target: lowerExpr(targetExpr, ctx, scopes),
  });
};
