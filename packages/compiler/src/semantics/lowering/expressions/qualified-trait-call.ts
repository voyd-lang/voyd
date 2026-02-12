import {
  type Expr,
  type Form,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../../../parser/index.js";
import type { HirExprId, SymbolId } from "../../ids.js";
import type { HirTypeExpr } from "../../hir/index.js";
import { toSourceSpan } from "../../utils.js";
import { lowerTypeExpr } from "../type-expressions.js";
import { traitMethodHasSelfReceiver } from "./trait-method-utils.js";
import type { LoweringParams } from "./types.js";

type ReceiverSource =
  | { kind: "target"; targetExpr: Expr }
  | { kind: "first-arg" };

export const lowerQualifiedTraitMethodCall = ({
  accessForm,
  traitSymbol,
  memberForm,
  receiverSource,
  ctx,
  scopes,
  lowerExpr,
}: {
  accessForm: Form;
  traitSymbol: SymbolId;
  memberForm: Form;
  receiverSource: ReceiverSource;
} & LoweringParams): HirExprId => {
  const elements = memberForm.toArray();
  if (elements.length === 0) {
    throw new Error("qualified trait call missing callee");
  }

  const calleeExpr = elements[0]!;
  if (!isIdentifierAtom(calleeExpr) && !isInternalIdentifierAtom(calleeExpr)) {
    throw new Error("qualified trait method name must be an identifier");
  }
  const methodName = calleeExpr.value;

  const traitRecord = ctx.symbolTable.getSymbol(traitSymbol);
  if (traitRecord.kind !== "trait") {
    throw new Error(
      `qualified trait method requires a trait (got ${traitRecord.kind})`,
    );
  }

  const traitDecl = ctx.decls.getTrait(traitSymbol);
  const traitMethods =
    traitDecl?.methods.filter(
      (method) => ctx.symbolTable.getSymbol(method.symbol).name === methodName,
    ) ?? [];
  if (traitMethods.length === 0) {
    throw new Error(
      `trait ${traitRecord.name} does not declare method ${methodName}`,
    );
  }

  if (!traitMethods.some((method) => traitMethodHasSelfReceiver(method))) {
    throw new Error(
      `qualified trait call requires a self receiver (method ${traitRecord.name}::${methodName})`,
    );
  }

  const potentialGenerics = elements[1];
  const hasTypeArguments =
    isForm(potentialGenerics) && formCallsInternal(potentialGenerics, "generics");
  const typeArguments = hasTypeArguments
    ? ((potentialGenerics as Form).rest
        .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
        .filter(Boolean) as HirTypeExpr[])
    : undefined;

  const firstArgIndex = hasTypeArguments ? 2 : 1;
  const receiverExpr =
    receiverSource.kind === "target"
      ? receiverSource.targetExpr
      : elements[firstArgIndex];
  if (!receiverExpr) {
    throw new Error(
      `qualified trait call ${traitRecord.name}::${methodName} missing receiver`,
    );
  }

  const argsStartIndex =
    receiverSource.kind === "target" ? firstArgIndex : firstArgIndex + 1;
  const args = elements.slice(argsStartIndex).map((arg) => {
    if (isForm(arg) && arg.calls(":")) {
      const labelExpr = arg.at(1);
      const valueExpr = arg.at(2);
      if (!isIdentifierAtom(labelExpr) || !valueExpr) {
        throw new Error("Invalid labeled argument");
      }
      return {
        label: labelExpr.value,
        expr: lowerExpr(valueExpr, ctx, scopes),
      };
    }
    return { expr: lowerExpr(arg, ctx, scopes) };
  });

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "method-call",
    ast: accessForm.syntaxId,
    span: toSourceSpan(accessForm),
    traitSymbol,
    target: lowerExpr(receiverExpr, ctx, scopes),
    method: methodName,
    args,
    typeArguments,
  });
};
