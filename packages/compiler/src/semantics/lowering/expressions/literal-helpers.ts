import type { Syntax } from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import type { HirExprId } from "../../ids.js";
import type { LowerContext } from "../types.js";

export const createVoidLiteralExpr = (
  spanSource: Syntax,
  ctx: LowerContext
): HirExprId =>
  ctx.builder.addExpression({
    kind: "expr",
    exprKind: "literal",
    ast: spanSource.syntaxId,
    span: toSourceSpan(spanSource),
    literalKind: "void",
    value: "void",
  });
