import {
  type Expr,
  type Form,
  type Syntax,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../../../parser/index.js";
import { literalProvidesAllFields } from "../../constructors.js";
import type { HirExprId } from "../ids.js";
import type { HirTypeExpr } from "../hir/index.js";
import { resolveTypeSymbol } from "../resolution.js";
import { lowerTypeExpr } from "../type-expressions.js";
import { toSourceSpan } from "../../utils.js";
import {
  isObjectLiteralForm,
  lowerObjectLiteralExpr,
} from "./object-literal.js";
import type { LoweringFormParams, LoweringParams } from "./types.js";
import {
  lowerConstructorArgFromEntry,
  lowerConstructorLiteralCall,
} from "./constructor-call.js";

type LowerCallFromElementsParams = LoweringParams & {
  calleeExpr: Expr;
  argsExprs: readonly Expr[];
  ast: Syntax;
};

type LowerNominalObjectLiteralParams = LoweringParams & {
  callee: Expr;
  args: readonly Expr[];
  ast: Syntax;
};

export const lowerCallFromElements = ({
  calleeExpr,
  argsExprs,
  ast,
  ctx,
  scopes,
  lowerExpr,
}: LowerCallFromElementsParams): HirExprId => {
  const potentialGenerics = argsExprs[0];
  const hasTypeArguments =
    isForm(potentialGenerics) &&
    formCallsInternal(potentialGenerics, "generics");
  const typeArguments = hasTypeArguments
    ? ((potentialGenerics as Form).rest
        .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
        .filter(Boolean) as NonNullable<ReturnType<typeof lowerTypeExpr>>[])
    : undefined;

  const calleeId = lowerExpr(calleeExpr, ctx, scopes);
  const args = argsExprs.slice(hasTypeArguments ? 1 : 0).map((arg) => {
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
    const expr = lowerExpr(arg, ctx, scopes);
    return { expr };
  });

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "call",
    ast: ast.syntaxId,
    span: toSourceSpan(ast),
    callee: calleeId,
    args,
    typeArguments,
  });
};

export const lowerNominalObjectLiteral = ({
  callee,
  args,
  ast,
  ctx,
  scopes,
  lowerExpr,
}: LowerNominalObjectLiteralParams): HirExprId | undefined => {
  if (!isIdentifierAtom(callee) || args.length === 0) {
    return undefined;
  }

  const genericsForm = args[0];
  const hasGenerics =
    isForm(genericsForm) && formCallsInternal(genericsForm, "generics");
  const literalArgIndex = hasGenerics ? 1 : 0;
  const literalArg = args[literalArgIndex];
  if (!literalArg || !isForm(literalArg) || !isObjectLiteralForm(literalArg)) {
    return undefined;
  }

  const typeArguments = hasGenerics
    ? ((genericsForm as Form).rest
        .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
        .filter(Boolean) as NonNullable<ReturnType<typeof lowerTypeExpr>>[])
    : undefined;

  const symbol = resolveTypeSymbol(callee.value, scopes.current(), ctx);
  if (typeof symbol !== "number") {
    return undefined;
  }
  const metadata = (ctx.symbolTable.getSymbol(symbol).metadata ?? {}) as {
    entity?: string;
  };
  const constructors = ctx.staticMethods.get(symbol)?.get("init");
  if (metadata.entity !== "object" && !(constructors && constructors.size > 0)) {
    return undefined;
  }
  if (constructors && constructors.size > 0) {
    const decl = ctx.decls.getObject(symbol);
    const providesAllFields =
      decl && literalProvidesAllFields(literalArg, decl.fields);
    if (!providesAllFields) {
      return lowerConstructorLiteralCall({
        callee,
        literal: literalArg,
        typeArguments,
        targetSymbol: symbol,
        ctx,
        scopes,
        lowerExpr,
        ast,
      });
    }
  }

  const target = {
    typeKind: "named" as const,
    path: [callee.value],
    symbol,
    ast: ast.syntaxId,
    span: toSourceSpan(ast),
    typeArguments,
  };

  return lowerObjectLiteralExpr({
    form: literalArg,
    ctx,
    scopes,
    lowerExpr,
    options: {
      literalKind: "nominal",
      target,
      targetSymbol: symbol,
    },
  });
};

export const lowerCall = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const callee = form.at(0);
  if (!callee) {
    throw new Error("call expression missing callee");
  }

  if (isIdentifierAtom(callee) && callee.value === "~") {
    const targetCallee = form.at(1);
    if (!targetCallee) {
      throw new Error("~ expression missing target");
    }
    const innerArgs = form.rest.slice(1);
    const nominal = lowerNominalObjectLiteral({
      callee: targetCallee,
      args: innerArgs,
      ast: form,
      ctx,
      scopes,
      lowerExpr,
    });
    const valueExpr =
      typeof nominal === "number"
        ? nominal
        : lowerCallFromElements({
            calleeExpr: targetCallee,
            argsExprs: innerArgs,
            ast: form,
            ctx,
            scopes,
            lowerExpr,
          });
    const loweredCallee = lowerExpr(callee, ctx, scopes);
    return ctx.builder.addExpression({
      kind: "expr",
      exprKind: "call",
      ast: form.syntaxId,
      span: toSourceSpan(form),
      callee: loweredCallee,
      args: [{ expr: valueExpr }],
    });
  }

  const nominalLiteral = lowerNominalObjectLiteral({
    callee,
    args: form.rest,
    ast: form,
    ctx,
    scopes,
    lowerExpr,
  });
  if (typeof nominalLiteral === "number") {
    return nominalLiteral;
  }

  return lowerCallFromElements({
    calleeExpr: callee,
    argsExprs: form.rest,
    ast: form,
    ctx,
    scopes,
    lowerExpr,
  });
};
