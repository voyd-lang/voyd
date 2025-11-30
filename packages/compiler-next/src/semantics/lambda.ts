import {
  type Expr,
  type Form,
  type IdentifierAtom,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
} from "../parser/index.js";

export interface ParsedLambdaSignature {
  parameters: readonly Expr[];
  returnType?: Expr;
  effectType?: Expr;
  typeParameters?: readonly IdentifierAtom[];
}

export const parseLambdaSignature = (
  signature: Expr | undefined
): ParsedLambdaSignature => {
  if (!signature) {
    throw new Error("lambda expression missing parameter list");
  }

  const { paramsExpr, returnType, effectType } = parseSignatureParts(signature);
  const { params, typeParameters } = parseParameters(paramsExpr);

  return {
    parameters: params,
    returnType,
    effectType,
    typeParameters,
  };
};

const parseSignatureParts = (
  expr: Expr
): { paramsExpr: Expr; returnType?: Expr; effectType?: Expr } => {
  if (isForm(expr) && expr.calls("->")) {
    return {
      paramsExpr: expr.at(1) ?? expr,
      returnType: expr.at(2),
    };
  }

  if (isForm(expr) && expr.calls(":")) {
    const candidateTail = expr.at(2);
    if (isForm(candidateTail) && candidateTail.calls("->")) {
      return {
        paramsExpr: expr.at(1) ?? expr,
        effectType: candidateTail.at(1),
        returnType: candidateTail.at(2),
      };
    }
  }

  return { paramsExpr: expr };
};

const parseParameters = (
  expr: Expr
): { params: readonly Expr[]; typeParameters?: readonly IdentifierAtom[] } => {
  if (!isForm(expr)) {
    return { params: [expr] };
  }

  const genericsForm = expr.at(0);
  const hasGenerics = isForm(genericsForm) && formCallsInternal(genericsForm, "generics");
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

  if (withoutGenerics.length === 0) {
    return { params: [], typeParameters };
  }

  const singleRemaining = withoutGenerics.length === 1 ? withoutGenerics[0] : undefined;
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
      throw new Error("lambda type parameters must be identifiers");
    }
    return entry;
  });
