import {
  type Expr,
  Form,
  type IdentifierAtom,
  type InternalIdentifierAtom,
  type Syntax,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../ast/index.js";
import { ParserSyntaxError } from "../errors.js";
import { normalizeNestedFunctionTypeAnnotation } from "./function-type-annotations.js";

export type SurfaceLambdaParameter = {
  name: IdentifierAtom | InternalIdentifierAtom;
  syntax: Syntax;
  bindingKind?: "mutable-ref";
  optional?: true;
  typeExpr?: Expr;
};

export interface ParsedLambdaSignature {
  parameters: readonly Expr[];
  normalizedParameters: readonly SurfaceLambdaParameter[];
  returnType?: Expr;
  effectType?: Expr;
  typeParameters?: readonly IdentifierAtom[];
}

export type SurfaceLambdaExpression = {
  form: Form;
  signatureExpr: Expr;
  signature: ParsedLambdaSignature;
  body: Expr;
};

const signatureCache = new WeakMap<Expr, ParsedLambdaSignature>();
const lambdaCache = new WeakMap<Form, SurfaceLambdaExpression>();

export const parseSurfaceLambdaExpression = (
  form: Form,
): SurfaceLambdaExpression => {
  const cached = lambdaCache.get(form);
  if (cached) return cached;
  const signatureExpr = form.at(1);
  const body = form.at(2);
  if (!signatureExpr || !body) {
    throw new ParserSyntaxError(
      "lambda expression missing signature or body",
      form.location,
    );
  }
  const parsed = {
    form,
    signatureExpr,
    signature: parseLambdaSignature(signatureExpr),
    body,
  };
  lambdaCache.set(form, parsed);
  return parsed;
};

export const parseLambdaSignature = (
  signature: Expr | undefined,
): ParsedLambdaSignature => {
  if (!signature) {
    throw new ParserSyntaxError("lambda expression missing parameter list");
  }
  const cached = signatureCache.get(signature);
  if (cached) return cached;

  const { paramsExpr, returnType, effectType } = parseSignatureParts(signature);
  const { params, typeParameters } = parseParameters(paramsExpr);

  const parsed = {
    parameters: params,
    normalizedParameters: params.flatMap(parseLambdaParameter),
    returnType,
    effectType,
    typeParameters,
  };
  signatureCache.set(signature, parsed);
  return parsed;
};

const parseLambdaParameter = (expr: Expr): SurfaceLambdaParameter[] => {
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    return [{ name: expr, syntax: expr }];
  }
  if (!isForm(expr)) {
    throw new ParserSyntaxError(
      "unsupported lambda parameter form",
      expr.location,
    );
  }
  if (expr.calls("~")) {
    const target = expr.at(1);
    if (!isIdentifierAtom(target) && !isInternalIdentifierAtom(target)) {
      throw new ParserSyntaxError(
        "lambda parameter name must be an identifier",
        expr.location,
      );
    }
    return [{ name: target, syntax: expr, bindingKind: "mutable-ref" }];
  }
  if (expr.calls(":") || expr.calls("?:")) {
    const { nameExpr, typeExpr, optional } =
      normalizeNestedFunctionTypeAnnotation(expr);
    let name = nameExpr;
    let bindingKind: "mutable-ref" | undefined;
    if (isForm(name) && name.calls("~")) {
      bindingKind = "mutable-ref";
      name = name.at(1);
    }
    if (!isIdentifierAtom(name) && !isInternalIdentifierAtom(name)) {
      throw new ParserSyntaxError(
        "lambda parameter name must be an identifier",
        expr.location,
      );
    }
    if (optional && !typeExpr) {
      throw new ParserSyntaxError(
        "optional lambda parameter missing type",
        expr.location,
      );
    }
    return [{ name, syntax: expr, bindingKind, optional, typeExpr }];
  }
  return expr.toArray().flatMap(parseLambdaParameter);
};

const parseSignatureParts = (
  expr: Expr,
): { paramsExpr: Expr; returnType?: Expr; effectType?: Expr } => {
  if (isForm(expr) && expr.calls("->")) {
    return {
      paramsExpr: expr.at(1) ?? expr,
      returnType: expr.at(2),
    };
  }

  if (isForm(expr) && expr.calls(":")) {
    const effectTail = expr.at(2);
    if (isForm(effectTail) && effectTail.calls("->")) {
      return {
        paramsExpr: expr.at(1) ?? expr,
        effectType: effectTail.at(1),
        returnType: effectTail.at(2),
      };
    }
  }

  return { paramsExpr: expr };
};

const parseParameters = (
  expr: Expr,
): { params: readonly Expr[]; typeParameters?: readonly IdentifierAtom[] } => {
  if (isForm(expr) && expr.calls("fn")) {
    let params = expr.rest;
    let typeParameters: IdentifierAtom[] | undefined;

    const maybeGenerics = params[0];
    if (isForm(maybeGenerics) && formCallsInternal(maybeGenerics, "generics")) {
      typeParameters = parseTypeParameters(maybeGenerics as Form);
      params = params.slice(1);
    }

    if (
      params.length === 1 &&
      isForm(params[0]) &&
      ((params[0] as Form).calls("tuple") ||
        (params[0] as Form).callsInternal("tuple"))
    ) {
      return { params: (params[0] as Form).rest, typeParameters };
    }

    return { params, typeParameters };
  }

  if (!isForm(expr)) {
    return { params: [expr] };
  }

  const genericsForm = expr.at(0);
  const hasGenerics =
    isForm(genericsForm) && formCallsInternal(genericsForm, "generics");
  const typeParameters = hasGenerics
    ? parseTypeParameters(genericsForm as Form)
    : undefined;
  const withoutGenerics = hasGenerics
    ? expr.toArray().slice(1)
    : expr.toArray();

  if (expr.calls("tuple") || expr.callsInternal("tuple")) {
    return { params: expr.rest, typeParameters };
  }

  if (expr.calls(":")) {
    return { params: [expr], typeParameters };
  }

  if (expr.calls("?:")) {
    return { params: [expr], typeParameters };
  }

  if (withoutGenerics.length === 0) {
    return { params: [], typeParameters };
  }

  const singleRemaining =
    withoutGenerics.length === 1 ? withoutGenerics[0] : undefined;
  if (
    isForm(singleRemaining) &&
    (singleRemaining.calls("tuple") || singleRemaining.callsInternal("tuple"))
  ) {
    return { params: singleRemaining.rest, typeParameters };
  }

  return { params: withoutGenerics, typeParameters };
};

const parseTypeParameters = (form: Form): IdentifierAtom[] =>
  form.rest.map((entry) => {
    if (!isIdentifierAtom(entry)) {
      throw new ParserSyntaxError(
        "lambda type parameters must be identifiers",
        entry.location,
      );
    }
    return entry;
  });
