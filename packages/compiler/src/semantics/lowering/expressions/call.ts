import {
  type Expr,
  type Form,
  type Syntax,
  type IdentifierAtom,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
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
import { resolveTypeSymbol } from "../resolution.js";
import { lowerNominalTargetTypeArgumentsFromMetadata } from "../../nominal-type-target.js";
import { substituteTypeParametersInTypeExpr } from "../../hir/type-expr-substitution.js";

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
  const aliasTargetTypeArguments = lowerAliasTargetTypeArguments({
    calleeExpr,
    namespaceTypeArguments: typeArguments,
    ctx,
    scope: scopes.current(),
  });
  const callTypeArguments = aliasTargetTypeArguments.consumeNamespaceTypeArguments
    ? aliasTargetTypeArguments.typeArguments
    : typeArguments;
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
    typeArguments:
      callTypeArguments && callTypeArguments.length > 0
        ? callTypeArguments
        : undefined,
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
  if (
    !isIdentifierAtom(calleeExpr) ||
    calleeExpr.isQuoted ||
    calleeExpr.value !== "is"
  ) {
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
  const decl = ctx.decls.getObject(calleeResolution.symbol);
  const lowerAsObjectLiteral =
    decl && literalShouldLowerAsObjectLiteral(literalForm, decl.fields);
  const constructorDecls = constructors
    ? Array.from(constructors)
        .map((symbol) => ctx.decls.getFunction(symbol))
        .filter(
          (
            entry,
          ): entry is NonNullable<ReturnType<typeof ctx.decls.getFunction>> =>
            Boolean(entry),
        )
    : [];
  const enclosingFunctionDecl = resolveEnclosingFunctionDecl({
    scope: scopes.current(),
    ctx,
  });
  const enclosingMetadata = (() => {
    if (!enclosingFunctionDecl) {
      return undefined;
    }
    return ctx.symbolTable.getSymbol(enclosingFunctionDecl.symbol)
      .metadata as
      | {
          implTarget?: unknown;
        }
      | undefined;
  })();
  const isBaseObjectInitializationInImpl =
    enclosingFunctionDecl?.name === "init" &&
    typeof enclosingMetadata?.implTarget === "number" &&
    enclosingMetadata.implTarget === calleeResolution.symbol;
  const forceBaseObjectInitializationInImpl =
    isBaseObjectInitializationInImpl &&
    constructorDecls.length > 0 &&
    !constructorLiteralCanMatchAnySignature({
      literal: literalForm,
      constructors: constructorDecls,
    });
  if (metadata.entity !== "object" && !(constructors && constructors.size > 0)) {
    return undefined;
  }
  if (
    constructors &&
    constructors.size > 0 &&
    !forceBaseObjectInitializationInImpl &&
    !lowerAsObjectLiteral
  ) {
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

const resolveEnclosingFunctionDecl = ({
  scope,
  ctx,
}: {
  scope: number;
  ctx: LoweringParams["ctx"];
}): LoweringParams["ctx"]["decls"]["functions"][number] | undefined => {
  let currentScope: number | null = scope;

  while (typeof currentScope === "number") {
    const scopeInfo = ctx.symbolTable.getScope(currentScope);
    if (scopeInfo.kind === "function") {
      return ctx.decls.functions.find(
        (entry) => entry.form?.syntaxId === scopeInfo.owner,
      );
    }
    currentScope = scopeInfo.parent;
  }

  return undefined;
};

type ConstructorLiteralArgumentShape = {
  label?: string;
};

const constructorLiteralCanMatchAnySignature = ({
  literal,
  constructors,
}: {
  literal: Form;
  constructors: readonly { params: readonly { label?: string; optional?: boolean }[] }[];
}): boolean => {
  if (constructors.length === 0) {
    return false;
  }
  const args = constructorLiteralArgumentsFromLiteral(literal);
  return constructors.some((constructor) =>
    constructorLiteralArgumentsMatchParams({
      args,
      params: constructor.params,
    }),
  );
};

const constructorLiteralArgumentsFromLiteral = (
  literal: Form,
): ConstructorLiteralArgumentShape[] =>
  literal.rest.map((entry) => {
    if (isForm(entry) && entry.calls(":")) {
      const nameExpr = entry.at(1);
      if (isIdentifierAtom(nameExpr) || isInternalIdentifierAtom(nameExpr)) {
        return { label: nameExpr.value };
      }
      return {};
    }
    if (isIdentifierAtom(entry) || isInternalIdentifierAtom(entry)) {
      return { label: entry.value };
    }
    return {};
  });

const constructorLiteralArgumentsMatchParams = ({
  args,
  params,
}: {
  args: readonly ConstructorLiteralArgumentShape[];
  params: readonly { label?: string; optional?: boolean }[];
}): boolean => {
  if (
    args.length > 0 &&
    args.every((arg) => arg.label !== undefined) &&
    params.length > 0 &&
    params.every((param) => param.label !== undefined)
  ) {
    const paramsByLabel = new Map<string, { optional: boolean }>();
    params.forEach((param) => {
      if (param.label) {
        paramsByLabel.set(param.label, { optional: Boolean(param.optional) });
      }
    });
    const seenLabels = new Set<string>();
    for (const arg of args) {
      if (!arg.label || !paramsByLabel.has(arg.label) || seenLabels.has(arg.label)) {
        return false;
      }
      seenLabels.add(arg.label);
    }
    return params.every(
      (param) => param.optional || !param.label || seenLabels.has(param.label),
    );
  }

  let argIndex = 0;
  let paramIndex = 0;

  while (paramIndex < params.length) {
    const param = params[paramIndex]!;
    const arg = args[argIndex];
    if (!arg) {
      if (param.optional) {
        paramIndex += 1;
        continue;
      }
      return false;
    }

    if (param.label) {
      if (arg.label === param.label) {
        argIndex += 1;
        paramIndex += 1;
        continue;
      }
      if (param.optional) {
        paramIndex += 1;
        continue;
      }
      return false;
    }

    if (arg.label !== undefined) {
      if (param.optional) {
        paramIndex += 1;
        continue;
      }
      return false;
    }

    argIndex += 1;
    paramIndex += 1;
  }

  return argIndex === args.length;
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

const lowerAliasTargetTypeArguments = ({
  calleeExpr,
  namespaceTypeArguments,
  scope,
  ctx,
}: {
  calleeExpr: Expr;
  namespaceTypeArguments?: readonly HirTypeExpr[];
  scope: ReturnType<LoweringParams["scopes"]["current"]>;
  ctx: LoweringParams["ctx"];
}): {
  typeArguments?: HirTypeExpr[];
  consumeNamespaceTypeArguments: boolean;
} => {
  if (!isIdentifierAtom(calleeExpr) && !isInternalIdentifierAtom(calleeExpr)) {
    return { consumeNamespaceTypeArguments: false };
  }
  const symbol = resolveTypeSymbol(calleeExpr.value, scope, ctx);
  if (typeof symbol !== "number") {
    return { consumeNamespaceTypeArguments: false };
  }
  const record = ctx.symbolTable.getSymbol(symbol);
  if (record.kind !== "type") {
    return { consumeNamespaceTypeArguments: false };
  }

  return lowerNominalTargetTypeArgumentsFromMetadata({
    source: record.metadata as Record<string, unknown> | undefined,
    namespaceTypeArguments,
    lowerTypeArgument: (entry) => lowerTypeExpr(entry, ctx, scope),
    substituteTypeArgument: ({ typeArgument, substitutionsByName }) =>
      substituteTypeParametersInTypeExpr({
        typeExpr: typeArgument,
        substitutionsByName,
      }),
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
