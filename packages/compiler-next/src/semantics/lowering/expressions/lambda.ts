import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../../../parser/index.js";
import { parseLambdaSignature } from "../../lambda.js";
import { toSourceSpan } from "../../utils.js";
import { resolveSymbol, resolveTypeSymbol } from "../resolution.js";
import { lowerTypeExpr, lowerTypeParameters } from "../type-expressions.js";
import type { HirExprId } from "../ids.js";
import { unwrapMutablePattern } from "./patterns.js";
import type { LoweringFormParams } from "./types.js";

export const lowerLambda = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const signatureExpr = form.at(1);
  const bodyExpr = form.at(2);
  if (!signatureExpr || !bodyExpr) {
    throw new Error("lambda expression missing signature or body");
  }

  const lambdaScope = ctx.scopeByNode.get(form.syntaxId);
  if (lambdaScope !== undefined) {
    scopes.push(lambdaScope);
  }

  const signature = parseLambdaSignature(signatureExpr);
  const parameters = signature.parameters.map((param) =>
    lowerLambdaParameter(param, ctx, scopes)
  );

  const typeParameters = lowerTypeParameters(
    signature.typeParameters?.map((param) => {
      const symbol = resolveTypeSymbol(param.value, scopes.current(), ctx);
      if (!symbol) {
        throw new Error(`unknown type parameter ${param.value} in lambda`);
      }
      return { symbol, ast: param };
    })
  );

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
  param: Expr,
  ctx: LoweringFormParams["ctx"],
  scopes: LoweringFormParams["scopes"]
) => {
  const { target, bindingKind } = unwrapMutablePattern(param);

  if (isIdentifierAtom(target) || isInternalIdentifierAtom(target)) {
    const symbol = resolveSymbol(target.value, scopes.current(), ctx);
    return {
      symbol,
      pattern: {
        kind: "identifier",
        symbol,
        span: toSourceSpan(param),
        bindingKind,
      },
      mutable: false,
      span: toSourceSpan(param),
    };
  }

  if (isForm(target) && target.calls(":")) {
    const nameExpr = target.at(1);
    const { target: nameTarget, bindingKind: nameBinding } =
      unwrapMutablePattern(nameExpr);
    if (
      !isIdentifierAtom(nameTarget) &&
      !isInternalIdentifierAtom(nameTarget)
    ) {
      throw new Error("lambda parameter name must be an identifier");
    }
    const symbol = resolveSymbol(nameTarget.value, scopes.current(), ctx);
    return {
      symbol,
      pattern: {
        kind: "identifier",
        symbol,
        span: toSourceSpan(param),
        bindingKind: nameBinding ?? bindingKind,
      },
      mutable: false,
      span: toSourceSpan(param),
      type: lowerTypeExpr(target.at(2), ctx, scopes.current()),
    };
  }

  if (isForm(target)) {
    const nestedParams = target
      .toArray()
      .map((entry) => lowerLambdaParameter(entry, ctx, scopes));
    if (nestedParams.length !== 1) {
      throw new Error("unexpected nested lambda parameter structure");
    }
    return nestedParams[0]!;
  }

  throw new Error("unsupported lambda parameter form");
};
