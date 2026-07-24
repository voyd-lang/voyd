import { type Expr, Form, isForm } from "../ast/index.js";
import { ParserSyntaxError } from "../errors.js";
import { parseLambdaSignature, type ParsedLambdaSignature } from "./lambda.js";

export type SurfaceFunctionType = {
  form: Form;
  signature: ParsedLambdaSignature;
  parameters: readonly {
    typeExpr: Expr;
    optional: boolean;
    bindingKind?: "mutable-ref";
  }[];
  returnType: Expr;
  effectType?: Expr;
};

type NestedFunctionTypeAnnotation = {
  nameExpr: Expr | undefined;
  typeExpr: Expr | undefined;
  optional?: true;
};

const annotationCache = new WeakMap<Form, NestedFunctionTypeAnnotation>();
const functionTypeCache = new WeakMap<Form, SurfaceFunctionType>();

export const normalizeNestedFunctionTypeAnnotation = (
  expr: Form,
): NestedFunctionTypeAnnotation => {
  const cached = annotationCache.get(expr);
  if (cached) return cached;
  const normalized = normalizeUncached(expr);
  annotationCache.set(expr, normalized);
  return normalized;
};

const normalizeUncached = (expr: Form): NestedFunctionTypeAnnotation => {
  const nameExpr = expr.at(1);
  const typeExpr = expr.at(2);
  const optional = expr.calls("?:") ? true : undefined;
  if (
    isForm(nameExpr) &&
    (nameExpr.calls(":") || nameExpr.calls("?:")) &&
    isForm(typeExpr) &&
    typeExpr.calls("->")
  ) {
    return {
      nameExpr: nameExpr.at(1),
      typeExpr: new Form({
        location: expr.location?.clone(),
        elements: [expr.first!, nameExpr.at(2)!, typeExpr],
      }),
      optional: optional === true || nameExpr.calls("?:") ? true : undefined,
    };
  }

  return { nameExpr, typeExpr, optional };
};

export const parseSurfaceFunctionType = (form: Form): SurfaceFunctionType => {
  const cached = functionTypeCache.get(form);
  if (cached) return cached;
  const signature = parseLambdaSignature(form);
  if (!signature.returnType) {
    throw new ParserSyntaxError(
      "function type missing return type",
      form.location,
    );
  }
  const parameters = signature.parameters.map((parameter) => {
    const mutable =
      isForm(parameter) && parameter.calls("~")
        ? parameter.at(1)
        : undefined;
    const rawParameter = mutable ?? parameter;
    const normalized =
      isForm(rawParameter) &&
      (rawParameter.calls(":") || rawParameter.calls("?:"))
        ? normalizeNestedFunctionTypeAnnotation(rawParameter)
        : undefined;
    const typeExpr = normalized?.typeExpr ?? rawParameter;
    if (!typeExpr) {
      throw new ParserSyntaxError(
        "function type parameter missing type",
        parameter.location,
      );
    }
    return {
      typeExpr,
      optional: normalized?.optional === true,
      ...(mutable ? { bindingKind: "mutable-ref" as const } : {}),
    };
  });
  const parsed = {
    form,
    signature,
    parameters,
    returnType: signature.returnType,
    effectType: signature.effectType,
  };
  functionTypeCache.set(form, parsed);
  return parsed;
};
