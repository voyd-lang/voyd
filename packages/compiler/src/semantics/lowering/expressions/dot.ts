import {
  type Expr,
  type Form,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../../../parser/index.js";
import type { HirExprId } from "../../ids.js";
import type { HirTypeExpr } from "../../hir/index.js";
import { extractConstructorTargetIdentifier } from "../../constructors.js";
import { toSourceSpan } from "../../utils.js";
import { lowerCallFromElements } from "./call.js";
import { resolveTypeSymbol } from "../resolution.js";
import { lowerTypeExpr } from "../type-expressions.js";
import { lowerMatch } from "./match.js";
import type { LoweringFormParams, LoweringParams } from "./types.js";

export const lowerDotExpr = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const targetExpr = form.at(1);
  const memberExpr = form.at(2);
  if (!targetExpr || !memberExpr) {
    throw new Error("dot expression missing target or member");
  }

  if (isForm(memberExpr) && memberExpr.calls("::")) {
    return lowerQualifiedTraitMethodCallExpr({
      dotForm: form,
      qualifiedMemberForm: memberExpr,
      targetExpr,
      ctx,
      scopes,
      lowerExpr,
    });
  }

  if (isForm(memberExpr) && memberExpr.calls("match")) {
    return lowerMatch({
      form: memberExpr,
      ctx,
      scopes,
      lowerExpr,
      operandOverride: targetExpr,
    });
  }

  if (isForm(memberExpr) && memberExpr.calls("=>")) {
    return lowerCallFromElements({
      calleeExpr: memberExpr,
      argsExprs: [targetExpr],
      ast: form,
      ctx,
      scopes,
      lowerExpr,
    });
  }

  if (isForm(memberExpr)) {
    return lowerMethodCallExpr({
      dotForm: form,
      memberForm: memberExpr,
      targetExpr,
      ctx,
      scopes,
      lowerExpr,
    });
  }

  throw new Error("unsupported dot expression");
};

const lowerQualifiedTraitMethodCallExpr = ({
  dotForm,
  qualifiedMemberForm,
  targetExpr,
  ctx,
  scopes,
  lowerExpr,
}: {
  dotForm: Form;
  qualifiedMemberForm: Form;
  targetExpr: Expr;
} & LoweringParams): HirExprId => {
  if (!qualifiedMemberForm.calls("::") || qualifiedMemberForm.length !== 3) {
    throw new Error("invalid qualified member expression");
  }

  const traitExpr = qualifiedMemberForm.at(1);
  const memberExpr = qualifiedMemberForm.at(2);
  if (!traitExpr || !memberExpr) {
    throw new Error("qualified member expression missing trait or member");
  }

  const traitIdentifier = extractConstructorTargetIdentifier(traitExpr);
  if (!traitIdentifier) {
    throw new Error("qualified trait method requires trait identifier");
  }
  const traitSymbol = resolveTypeSymbol(traitIdentifier.value, scopes.current(), ctx);
  if (typeof traitSymbol !== "number") {
    throw new Error(`unknown trait ${traitIdentifier.value}`);
  }
  const traitRecord = ctx.symbolTable.getSymbol(traitSymbol);
  if (traitRecord.kind !== "trait") {
    throw new Error(
      `qualified trait method requires a trait (got ${traitRecord.kind})`,
    );
  }

  if (!isForm(memberExpr)) {
    throw new Error("qualified trait member must be a call expression");
  }

  const elements = memberExpr.toArray();
  if (!elements.length) {
    throw new Error("qualified trait method call missing callee");
  }

  const calleeExpr = elements[0]!;
  if (!isIdentifierAtom(calleeExpr) && !isInternalIdentifierAtom(calleeExpr)) {
    throw new Error("qualified trait method name must be an identifier");
  }

  const traitDecl = ctx.decls.getTrait(traitSymbol);
  const traitMethods =
    traitDecl?.methods.filter(
      (method) => ctx.symbolTable.getSymbol(method.symbol).name === calleeExpr.value,
    ) ?? [];
  if (traitMethods.length === 0) {
    throw new Error(
      `trait ${traitRecord.name} does not declare method ${calleeExpr.value}`,
    );
  }
  const selfTraitMethods = traitMethods.filter(
    (method) => traitMethodHasSelfReceiver(method),
  );
  if (selfTraitMethods.length === 0) {
    throw new Error(
      `qualified trait call requires a self receiver (method ${traitRecord.name}::${calleeExpr.value})`,
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

  const args = elements.slice(hasTypeArguments ? 2 : 1).map((arg) => {
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
    ast: dotForm.syntaxId,
    span: toSourceSpan(dotForm),
    traitSymbol,
    target: lowerExpr(targetExpr, ctx, scopes),
    method: calleeExpr.value,
    args,
    typeArguments,
  });
};

const traitMethodHasSelfReceiver = ({
  params,
}: {
  params: readonly { name: string; ast?: unknown }[];
}): boolean => {
  const receiver = params[0];
  if (!receiver) {
    return false;
  }
  if (receiver.name === "self") {
    return true;
  }
  return Boolean(
    receiver.ast &&
      isIdentifierAtom(receiver.ast) &&
      receiver.ast.value === "self",
  );
};

const lowerMethodCallExpr = ({
  dotForm,
  memberForm,
  targetExpr,
  ctx,
  scopes,
  lowerExpr,
}: {
  dotForm: Form;
  memberForm: Form;
  targetExpr: Expr;
} & LoweringParams): HirExprId => {
  const elements = memberForm.toArray();
  if (!elements.length) {
    throw new Error("method access missing callee");
  }

  const calleeExpr = elements[0]!;
  if (!isIdentifierAtom(calleeExpr) && !isInternalIdentifierAtom(calleeExpr)) {
    throw new Error("method name must be an identifier");
  }

  const potentialGenerics = elements[1];
  const hasTypeArguments =
    isForm(potentialGenerics) &&
    formCallsInternal(potentialGenerics, "generics");
  const typeArguments = hasTypeArguments
    ? ((potentialGenerics as Form).rest
        .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
        .filter(Boolean) as HirTypeExpr[])
    : undefined;
  const args = elements.slice(hasTypeArguments ? 2 : 1).map((arg) => {
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
    ast: dotForm.syntaxId,
    span: toSourceSpan(dotForm),
    target: lowerExpr(targetExpr, ctx, scopes),
    method: calleeExpr.value,
    args,
    typeArguments,
  });
};
