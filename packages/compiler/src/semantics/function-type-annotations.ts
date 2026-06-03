import {
  type Expr,
  Form,
  IdentifierAtom,
  isForm,
} from "../parser/index.js";

export const normalizeNestedFunctionTypeAnnotation = (
  expr: Form
): { nameExpr: Expr | undefined; typeExpr: Expr | undefined; optional?: true } => {
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
      typeExpr: new Form([
        new IdentifierAtom(":"),
        nameExpr.at(2)!,
        typeExpr,
      ]),
      optional: optional ?? (nameExpr.calls("?:") ? true : undefined),
    };
  }

  return { nameExpr, typeExpr, optional };
};
