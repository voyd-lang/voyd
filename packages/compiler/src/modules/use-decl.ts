import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
} from "../parser/index.js";

export type TopLevelUseDeclVisibility = "module" | "pub";

export interface ParsedTopLevelUseDecl {
  pathExpr: Expr;
  visibility: TopLevelUseDeclVisibility;
}

const PUB_DECL_KEYWORDS = new Set([
  "fn",
  "type",
  "obj",
  "trait",
  "impl",
  "eff",
  "mod",
  "macro",
  "macro_let",
  "functional-macro",
  "define-macro-variable",
]);

const isUsePathExpr = (expr: Expr | undefined): expr is Expr => {
  if (!expr) {
    return false;
  }
  if (isIdentifierAtom(expr)) {
    return true;
  }
  if (!isForm(expr)) {
    return false;
  }
  return (
    expr.calls("::") || expr.calls("as") || expr.callsInternal("object_literal")
  );
};

export const parseTopLevelUseDecl = (
  form: Form,
): ParsedTopLevelUseDecl | null => {
  const first = form.at(0);

  if (isIdentifierAtom(first) && first.value === "use") {
    const pathExpr = form.at(1);
    if (!pathExpr) {
      throw new Error("use statement missing a path");
    }
    return { pathExpr, visibility: "module" };
  }

  if (!isIdentifierAtom(first) || first.value !== "pub") {
    return null;
  }

  const second = form.at(1);
  if (!second) {
    throw new Error("pub export statement missing a module path");
  }

  if (isIdentifierAtom(second) && second.value === "use") {
    const pathExpr = form.at(2);
    if (!pathExpr) {
      throw new Error("use statement missing a path");
    }
    return { pathExpr, visibility: "pub" };
  }

  if (
    isIdentifierAtom(second) &&
    PUB_DECL_KEYWORDS.has(second.value)
  ) {
    return null;
  }

  if (!isUsePathExpr(second)) {
    return null;
  }

  return { pathExpr: second, visibility: "pub" };
};
