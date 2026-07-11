import { parseSurfaceLambdaExpression } from "../../../parser/surface/index.js";
import { toSourceSpan } from "../../../parser/surface/utils.js";
import { resolveSymbol, resolveTypeSymbol } from "../resolution.js";
import {
  lowerTypeExpr,
  lowerTypeParameters,
  wrapInOptionalTypeExpr,
} from "../type-expressions.js";
import type { HirExprId } from "../../ids.js";
import type { HirParameter } from "../../hir/index.js";
import type { LoweringFormParams } from "./types.js";

export const lowerLambda = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const { signature, body: bodyExpr } = parseSurfaceLambdaExpression(form);

  const lambdaScope = ctx.scopeByNode.get(form.syntaxId);
  if (lambdaScope !== undefined) {
    scopes.push(lambdaScope);
  }

  const parameters = signature.normalizedParameters.map((param) =>
    lowerLambdaParameter(param, ctx, scopes),
  );

  const typeParameters = lowerTypeParameters({
    params: signature.typeParameters?.map((param) => {
      const symbol = resolveTypeSymbol(param.value, scopes.current(), ctx);
      if (!symbol) {
        throw new Error(`unknown type parameter ${param.value} in lambda`);
      }
      return { symbol, ast: param };
    }),
    ctx,
    scope: scopes.current(),
  });

  const returnType = lowerTypeExpr(signature.returnType, ctx, scopes.current());
  const effectType = lowerTypeExpr(signature.effectType, ctx, scopes.current());
  const body = lowerExpr(bodyExpr, ctx, scopes);

  if (lambdaScope !== undefined) {
    scopes.pop();
  }

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "lambda",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    typeParameters,
    parameters,
    returnType,
    effectType,
    body,
    captures: [],
  });
};

const lowerLambdaParameter = (
  param: import("../../../parser/surface/index.js").SurfaceLambdaParameter,
  ctx: LoweringFormParams["ctx"],
  scopes: LoweringFormParams["scopes"],
): HirParameter => {
  const symbol = resolveSymbol(param.name.value, scopes.current(), ctx);
  const lowered = lowerTypeExpr(param.typeExpr, ctx, scopes.current());
  const type =
    lowered && param.optional
      ? wrapInOptionalTypeExpr({ inner: lowered, ctx, scope: scopes.current() })
      : lowered;
  return {
    symbol,
    pattern: {
      kind: "identifier",
      symbol,
      span: toSourceSpan(param.syntax),
      bindingKind: param.bindingKind,
    },
    mutable: false,
    span: toSourceSpan(param.syntax),
    optional: param.optional,
    type,
  };
};
