import {
  type Expr,
  type Form,
  type Syntax,
  type IdentifierAtom,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
} from "../../../parser/index.js";
import { literalShouldLowerAsObjectLiteral } from "../../constructors.js";
import type { HirExprId } from "../../ids.js";
import type { HirTypeExpr } from "../../hir/index.js";
import { lowerTypeExpr } from "../type-expressions.js";
import { resolveNamedTypeTarget } from "../named-type-resolution.js";
import { toSourceSpan } from "../../utils.js";
import {
  isObjectLiteralForm,
  lowerObjectLiteralExpr,
} from "./object-literal.js";
import type { LoweringFormParams, LoweringParams } from "./types.js";
import {
  lowerConstructorLiteralCall,
} from "./constructor-call.js";
import { createBoolLiteralExpr } from "./literal-helpers.js";

type LowerCallFromElementsParams = LoweringParams & {
  calleeExpr: Expr;
  argsExprs: readonly Expr[];
  ast: Syntax;
};

type LowerNominalObjectLiteralParams = LoweringParams & {
  callee: Expr;
  args: readonly Expr[];
  ast: Expr;
  fallbackTypeArguments?: HirTypeExpr[];
  allowedTargetSymbols?: ReadonlySet<number>;
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
  const callArgsExprs = argsExprs.slice(hasTypeArguments ? 1 : 0);
  const typeArguments = hasTypeArguments
    ? ((potentialGenerics as Form).rest
        .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
        .filter(Boolean) as NonNullable<ReturnType<typeof lowerTypeExpr>>[])
    : undefined;
  const isTypeCheck = tryLowerIsTypeCheckCall({
    calleeExpr,
    argsExprs: callArgsExprs,
    ast,
    ctx,
    scopes,
    lowerExpr,
  });
  if (typeof isTypeCheck === "number") {
    return isTypeCheck;
  }

  const calleeId = lowerExpr(calleeExpr, ctx, scopes);
  const args = callArgsExprs.map((arg) => {
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

const tryLowerIsTypeCheckCall = ({
  calleeExpr,
  argsExprs,
  ast,
  ctx,
  scopes,
  lowerExpr,
}: LowerCallFromElementsParams): HirExprId | undefined => {
  if (!isIdentifierAtom(calleeExpr) || calleeExpr.value !== "is") {
    return undefined;
  }
  const [discriminantExpr, typeExpr, ...rest] = argsExprs;
  if (!discriminantExpr || !typeExpr || rest.length > 0) {
    return undefined;
  }

  const type = (() => {
    try {
      return lowerTypeExpr(typeExpr, ctx, scopes.current());
    } catch {
      return undefined;
    }
  })();
  if (!type) {
    return undefined;
  }

  const discriminant = lowerExpr(discriminantExpr, ctx, scopes);
  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "match",
    ast: ast.syntaxId,
    span: toSourceSpan(ast),
    discriminant,
    arms: [
      {
        pattern: {
          kind: "type",
          type,
          span: toSourceSpan(typeExpr),
        },
        value: createBoolLiteralExpr({
          value: true,
          spanSource: typeExpr,
          ctx,
        }),
      },
      {
        pattern: {
          kind: "wildcard",
          span: toSourceSpan(ast),
        },
        value: createBoolLiteralExpr({
          value: false,
          spanSource: ast,
          ctx,
        }),
      },
    ],
  });
};

export const lowerNominalObjectLiteral = ({
  callee,
  args,
  ast,
  fallbackTypeArguments,
  allowedTargetSymbols,
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
  if (
    allowedTargetSymbols &&
    !allowedTargetSymbols.has(calleeResolution.symbol)
  ) {
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

  const parsedTypeArguments = hasGenerics
    ? ((genericsForm as Form).rest
        .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
        .filter(Boolean) as NonNullable<ReturnType<typeof lowerTypeExpr>>[])
    : undefined;
  const mergedTypeArguments =
    parsedTypeArguments && fallbackTypeArguments && fallbackTypeArguments.length > 0
      ? [...parsedTypeArguments, ...fallbackTypeArguments]
      : parsedTypeArguments ?? fallbackTypeArguments;
  const typeArguments = calleeResolution.typeArguments ?? mergedTypeArguments;

  const metadata = (ctx.symbolTable.getSymbol(calleeResolution.symbol).metadata ?? {}) as {
    entity?: string;
  };
  const constructors = ctx.staticMethods.get(calleeResolution.symbol)?.get("init");
  if (metadata.entity !== "object" && !(constructors && constructors.size > 0)) {
    return undefined;
  }
  if (constructors && constructors.size > 0) {
    const decl = ctx.decls.getObject(calleeResolution.symbol);
    const lowerAsObjectLiteral =
      decl && literalShouldLowerAsObjectLiteral(literalForm, decl.fields);
    if (!lowerAsObjectLiteral) {
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

const resolveNominalTarget = ({
  callee,
  ctx,
  scope,
}: {
  callee: Expr;
  ctx: LoweringParams["ctx"];
  scope: ReturnType<LoweringParams["scopes"]["current"]>;
}): NominalTargetResolution | undefined => {
  const target = resolveNamedTypeTarget({
    expr: callee,
    scope,
    ctx,
    parseTypeArguments: (entries) =>
      entries
        .map((entry) => lowerTypeExpr(entry, ctx, scope))
        .filter(Boolean) as NonNullable<ReturnType<typeof lowerTypeExpr>>[],
    allowNamespacedSymbolKind: (kind) => kind === "type",
    requireResolvedLocalSymbol: true,
  });
  if (!target || typeof target.symbol !== "number") {
    return undefined;
  }
  return {
    symbol: target.symbol,
    path: target.path,
    calleeSyntax: target.name,
    typeArguments: target.typeArguments,
  };
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
