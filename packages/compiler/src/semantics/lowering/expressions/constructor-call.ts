import {
  type Expr,
  type Form,
  type IdentifierAtom,
} from "../../../parser/index.js";
import { toSourceSpan } from "../../../parser/surface/utils.js";
import type { HirExprId, SymbolId } from "../../ids.js";
import type { HirTypeExpr } from "../../hir/index.js";
import {
  lowerResolvedCallee,
  resolveStaticMethodResolution,
} from "./resolution-helpers.js";
import type { LoweringParams } from "./types.js";
import {
  parseValueBraceEntries,
  type SurfaceValueBraceEntry,
} from "../../../parser/surface/index.js";

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
  const args = parseValueBraceEntries(literal, "constructor literal").map(
    (entry) => lowerConstructorArgFromEntry({ entry, ctx, scopes, lowerExpr }),
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
}: LoweringParams & { entry: SurfaceValueBraceEntry }): {
  label?: string;
  expr: HirExprId;
} => {
  if (entry.kind === "spread") {
    return { expr: lowerExpr(entry.value, ctx, scopes) };
  }
  if (entry.kind === "field") {
    return {
      label: entry.name.value,
      expr: lowerExpr(entry.value, ctx, scopes),
    };
  }
  return {
    label: entry.name.value,
    expr: lowerExpr(entry.value, ctx, scopes),
  };
};
