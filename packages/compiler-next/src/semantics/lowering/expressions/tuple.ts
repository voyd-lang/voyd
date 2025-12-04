import type { Form } from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import type { HirExprId } from "../../ids.js";
import type { LoweringFormParams } from "./types.js";

export const lowerTupleExpr = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const elements = form.rest.map((entry) => lowerExpr(entry, ctx, scopes));
  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "tuple",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    elements,
  });
};
