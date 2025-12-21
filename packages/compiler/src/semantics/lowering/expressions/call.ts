import {
  type Expr,
  type Form,
  type Syntax,
  type IdentifierAtom,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
} from "../../../parser/index.js";
import { literalProvidesAllFields } from "../../constructors.js";
import type { HirExprId } from "../../ids.js";
import type { HirTypeExpr } from "../../hir/index.js";
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
import { resolveModuleMemberResolution } from "./resolution-helpers.js";
import {
  extractNamespaceSegments,
  resolveModulePathSymbol,
} from "./namespace-resolution.js";

type LowerCallFromElementsParams = LoweringParams & {
  calleeExpr: Expr;
  argsExprs: readonly Expr[];
  ast: Syntax;
};

type LowerNominalObjectLiteralParams = LoweringParams & {
  callee: Expr;
  args: readonly Expr[];
  ast: Expr;
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
  if (args.length === 0) return undefined;

  const calleeResolution = resolveNominalTarget({
    callee,
    ctx,
    scope: scopes.current(),
  });
  if (!calleeResolution) {
    return undefined;
  }

  const genericsForm = args[0];
  const hasGenerics =
    !calleeResolution.typeArguments &&
    isForm(genericsForm) &&
    formCallsInternal(genericsForm, "generics");
  const literalArgIndex = hasGenerics ? 1 : 0;
  const literalArg = args[literalArgIndex];
  if (!literalArg || !isForm(literalArg) || !isObjectLiteralForm(literalArg)) {
    return undefined;
  }
  const literalForm: Form = literalArg;

  const typeArguments =
    calleeResolution.typeArguments ??
    (hasGenerics
      ? ((genericsForm as Form).rest
          .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
          .filter(Boolean) as NonNullable<ReturnType<typeof lowerTypeExpr>>[])
      : undefined);

  const metadata = (ctx.symbolTable.getSymbol(calleeResolution.symbol).metadata ?? {}) as {
    entity?: string;
  };
  const constructors = ctx.staticMethods.get(calleeResolution.symbol)?.get("init");
  if (metadata.entity !== "object" && !(constructors && constructors.size > 0)) {
    return undefined;
  }
  if (constructors && constructors.size > 0) {
    const decl = ctx.decls.getObject(calleeResolution.symbol);
    const providesAllFields =
      decl && literalProvidesAllFields(literalForm, decl.fields);
    if (!providesAllFields) {
      return lowerConstructorLiteralCall({
        callee: calleeResolution.calleeSyntax,
        literal: literalForm,
        typeArguments,
        targetSymbol: calleeResolution.symbol,
        ctx,
        scopes,
        lowerExpr,
        ast,
      });
    }
  }

  const target = {
    typeKind: "named" as const,
    path: calleeResolution.path,
    symbol: calleeResolution.symbol,
    ast: ast.syntaxId,
    span: toSourceSpan(ast),
    typeArguments,
  };

  return lowerObjectLiteralExpr({
    form: literalForm,
    ctx,
    scopes,
    lowerExpr,
    options: {
      literalKind: "nominal",
      target,
      targetSymbol: calleeResolution.symbol,
    },
  });
};

type NominalTargetResolution = {
  symbol: number;
  path: string[];
  calleeSyntax: IdentifierAtom;
  typeArguments?: HirTypeExpr[];
};

const isGenericsForm = (expr: Expr | undefined): expr is Form =>
  isForm(expr) && formCallsInternal(expr, "generics");

const extractCalleeTypeArguments = ({
  callee,
  ctx,
  scope,
}: {
  callee: Expr;
  ctx: LoweringParams["ctx"];
  scope: ReturnType<LoweringParams["scopes"]["current"]>;
}): { name: IdentifierAtom; typeArguments?: HirTypeExpr[] } | undefined => {
  if (isIdentifierAtom(callee)) {
    return { name: callee, typeArguments: undefined };
  }

  if (isForm(callee)) {
    const head = callee.at(0);
    const second = callee.at(1);
    if (isIdentifierAtom(head) && isGenericsForm(second) && callee.length === 2) {
      const typeArguments = (second as Form).rest
        .map((entry) => lowerTypeExpr(entry, ctx, scope))
        .filter(Boolean) as NonNullable<ReturnType<typeof lowerTypeExpr>>[];
      return { name: head, typeArguments };
    }
  }

  return undefined;
};

const resolveNominalTarget = ({
  callee,
  ctx,
  scope,
}: {
  callee: Expr;
  ctx: LoweringParams["ctx"];
  scope: ReturnType<LoweringParams["scopes"]["current"]>;
}): NominalTargetResolution | undefined => {
  if (isIdentifierAtom(callee)) {
    const symbol = resolveTypeSymbol(callee.value, scope, ctx);
    if (typeof symbol !== "number") return undefined;
    return { symbol, path: [callee.value], calleeSyntax: callee };
  }

  const calleeTypeArgs = extractCalleeTypeArguments({ callee, ctx, scope });
  if (calleeTypeArgs) {
    const symbol = resolveTypeSymbol(calleeTypeArgs.name.value, scope, ctx);
    if (typeof symbol !== "number") return undefined;
    return {
      symbol,
      path: [calleeTypeArgs.name.value],
      calleeSyntax: calleeTypeArgs.name,
      typeArguments: calleeTypeArgs.typeArguments,
    };
  }

  if (isForm(callee) && callee.calls("::") && callee.length === 3) {
    const moduleExpr = callee.at(1);
    const memberExpr = callee.at(2);
    if (!moduleExpr || !memberExpr) return undefined;

    const moduleSymbol = resolveModulePathSymbol(moduleExpr, scope, ctx);
    if (typeof moduleSymbol !== "number") return undefined;

    const memberTypeArgs = extractCalleeTypeArguments({ callee: memberExpr, ctx, scope });
    const memberName = memberTypeArgs?.name ?? (isIdentifierAtom(memberExpr) ? memberExpr : undefined);
    if (!memberName) return undefined;

    const memberTable = ctx.moduleMembers.get(moduleSymbol);
    if (!memberTable) return undefined;

    const resolution = resolveModuleMemberResolution({
      name: memberName.value,
      moduleSymbol,
      memberTable,
      ctx,
    });
    if (!resolution || resolution.kind !== "symbol") return undefined;

    const record = ctx.symbolTable.getSymbol(resolution.symbol);
    if (record.kind !== "type") return undefined;

    const moduleSegments =
      extractNamespaceSegments(moduleExpr) ?? [ctx.symbolTable.getSymbol(moduleSymbol).name];
    return {
      symbol: resolution.symbol,
      path: [...moduleSegments, memberName.value],
      calleeSyntax: memberName,
      typeArguments: memberTypeArgs?.typeArguments,
    };
  }

  return undefined;
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
    const loweredCallee = lowerExpr(callee, ctx, scopes);
    const target = form.at(1);
    if (!target) {
      throw new Error("~ expression missing target");
    }

    const lowerUnary = (valueExpr: HirExprId) =>
      ctx.builder.addExpression({
        kind: "expr",
        exprKind: "call",
        ast: form.syntaxId,
        span: toSourceSpan(form),
        callee: loweredCallee,
        args: [{ expr: valueExpr }],
      });

    // Newer parsing prefers `~(Box { ... })`-like grouping, which means the
    // inner nominal literal is already a single expression.
    if (form.length === 2) {
      if (isForm(target)) {
        const innerCallee = target.at(0);
        const nominal = innerCallee
          ? lowerNominalObjectLiteral({
              callee: innerCallee,
              args: target.rest,
              ast: target,
              ctx,
              scopes,
              lowerExpr,
            })
          : undefined;
        if (typeof nominal === "number") {
          return lowerUnary(nominal);
        }
      }
      return lowerUnary(lowerExpr(target, ctx, scopes));
    }

    // Backwards-compatible: `~ Box { ... }` where the constructor target and
    // its args are still passed as separate expressions.
    const innerArgs = form.rest.slice(1);
    const nominal = lowerNominalObjectLiteral({
      callee: target,
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
            calleeExpr: target,
            argsExprs: innerArgs,
            ast: form,
            ctx,
            scopes,
            lowerExpr,
          });

    return lowerUnary(valueExpr);
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
