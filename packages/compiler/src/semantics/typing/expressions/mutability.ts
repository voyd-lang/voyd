import type {
  HirBindingKind,
  HirExpression,
} from "../../hir/index.js";
import type { HirExprId, SourceSpan, SymbolId } from "../../ids.js";
import {
  diagnosticFromCode,
  emitDiagnostic,
} from "../../../diagnostics/index.js";
import type { TypingContext } from "../types.js";

type BindingMetadata = {
  mutable?: boolean;
  declarationSpan?: SourceSpan;
  bindingKind?: HirBindingKind;
};

export const assertMutableBinding = ({
  symbol,
  span,
  ctx,
}: {
  symbol: SymbolId;
  span: SourceSpan;
  ctx: TypingContext;
}): void => {
  const record = ctx.symbolTable.getSymbol(symbol);
  const metadata = (record.metadata ?? {}) as BindingMetadata;
  if (metadata.mutable) {
    return;
  }

  const related = metadata.declarationSpan
    ? [
        diagnosticFromCode({
          code: "TY0001",
          params: { kind: "binding-declaration", name: record.name },
          span: metadata.declarationSpan,
          severity: "note",
        }),
      ]
    : undefined;

  emitDiagnostic({
    ctx,
    code: "TY0001",
    params: { kind: "immutable-assignment", name: record.name },
    span,
    related,
  });
};

export const assertMutableObjectBinding = ({
  symbol,
  span,
  ctx,
  reason,
}: {
  symbol: SymbolId;
  span: SourceSpan;
  ctx: TypingContext;
  reason: string;
}): void => {
  const record = ctx.symbolTable.getSymbol(symbol);
  const metadata = (record.metadata ?? {}) as BindingMetadata;
  if (metadata.bindingKind === "mutable-ref") {
    return;
  }

  const related = metadata.declarationSpan
    ? [
        diagnosticFromCode({
          code: "TY0004",
          params: { kind: "binding-declaration", binding: record.name },
          span: metadata.declarationSpan,
          severity: "note",
        }),
      ]
    : undefined;

  emitDiagnostic({
    ctx,
    code: "TY0004",
    params: {
      kind: "immutable-object",
      binding: record.name,
      reason,
    },
    span,
    related,
  });
};

export const findBindingSymbol = (
  exprId: HirExprId,
  ctx: TypingContext
): SymbolId | undefined => {
  const expr = ctx.hir.expressions.get(exprId) as HirExpression | undefined;
  if (!expr) {
    return undefined;
  }
  if (expr.exprKind === "identifier") {
    return expr.symbol;
  }
  if (expr.exprKind === "field-access") {
    return findBindingSymbol(expr.target, ctx);
  }
  return undefined;
};
