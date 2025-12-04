import {
  type Expr,
  type Form,
  type IdentifierAtom,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import type { HirExprId, SymbolId } from "../../ids.js";
import type { HirTypeExpr } from "../../hir/index.js";
import {
  lowerResolvedCallee,
  resolveStaticMethodResolution,
} from "./resolution-helpers.js";
import type { LoweringParams } from "./types.js";

type LowerConstructorLiteralParams = LoweringParams & {
  callee: IdentifierAtom;
  literal: Form;
  typeArguments?: HirTypeExpr[];
  targetSymbol: SymbolId;
  ast: Expr;
};

export const lowerConstructorLiteralCall = ({
  callee,
  literal,
  typeArguments,
  targetSymbol,
  ctx,
  scopes,
  lowerExpr,
  ast,
}: LowerConstructorLiteralParams): HirExprId => {
  const methodTable = ctx.staticMethods.get(targetSymbol);
  if (!methodTable) {
    const targetName = ctx.symbolTable.getSymbol(targetSymbol).name;
    throw new Error(`type ${targetName} does not declare constructors`);
  }
  const resolution = resolveStaticMethodResolution({
    name: "init",
    targetSymbol,
    methodTable,
    ctx,
  });
  const calleeExpr = lowerResolvedCallee({
    resolution,
    syntax: callee,
    ctx,
  });
  const args = literal.rest.map((entry) =>
    lowerConstructorArgFromEntry({ entry, ctx, scopes, lowerExpr })
  );

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "call",
    ast: ast.syntaxId,
    span: toSourceSpan(ast),
    callee: calleeExpr,
    args,
    typeArguments:
      typeArguments && typeArguments.length > 0 ? typeArguments : undefined,
  });
};

export const lowerConstructorArgFromEntry = ({
  entry,
  ctx,
  scopes,
  lowerExpr,
}: LoweringParams & { entry: Expr | undefined }): { label?: string; expr: HirExprId } => {
  if (!entry) {
    throw new Error("constructor argument missing expression");
  }

  if (isForm(entry) && entry.calls("...")) {
    const valueExpr = entry.at(1);
    if (!valueExpr) {
      throw new Error("spread constructor argument missing value");
    }
    return { expr: lowerExpr(valueExpr, ctx, scopes) };
  }

  if (isForm(entry) && entry.calls(":")) {
    const nameExpr = entry.at(1);
    const valueExpr = entry.at(2);
    if (!isIdentifierAtom(nameExpr) || !valueExpr) {
      throw new Error("constructor literal argument must name a field");
    }
    return {
      label: nameExpr.value,
      expr: lowerExpr(valueExpr, ctx, scopes),
    };
  }

  if (isIdentifierAtom(entry) || isInternalIdentifierAtom(entry)) {
    return {
      label: entry.value,
      expr: lowerExpr(entry, ctx, scopes),
    };
  }

  throw new Error("unsupported constructor literal entry");
};
