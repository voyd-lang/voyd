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

export type TopLevelDeclClassification =
  | {
      kind: "use-decl";
      pathExpr: Expr;
      visibility: TopLevelUseDeclVisibility;
    }
  | {
      kind: "inline-module-decl";
      name: string;
      body: Form;
      visibility: TopLevelUseDeclVisibility;
    }
  | {
      kind: "unsupported-mod-decl";
      visibility: TopLevelUseDeclVisibility;
    }
  | {
      kind: "macro-decl";
      visibility: TopLevelUseDeclVisibility;
    }
  | { kind: "other" };

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

const MACRO_DECL_KEYWORDS = new Set([
  "functional-macro",
  "define-macro-variable",
  "macro",
  "macro_let",
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

const visibilityAndKeywordFor = (
  form: Form,
): {
  visibility: TopLevelUseDeclVisibility;
  keywordExpr: Expr | undefined;
  offset: number;
} => {
  const first = form.at(0);
  if (isIdentifierAtom(first) && first.value === "pub") {
    return {
      visibility: "pub",
      keywordExpr: form.at(1),
      offset: 1,
    };
  }
  return {
    visibility: "module",
    keywordExpr: first,
    offset: 0,
  };
};

const classifyModDecl = ({
  form,
  visibility,
  offset,
}: {
  form: Form;
  visibility: TopLevelUseDeclVisibility;
  offset: number;
}): TopLevelDeclClassification => {
  const nameExpr = form.at(offset + 1);
  if (!isIdentifierAtom(nameExpr)) {
    return { kind: "other" };
  }
  const bodyExpr = form.at(offset + 2);
  if (isForm(bodyExpr) && bodyExpr.calls("block")) {
    return {
      kind: "inline-module-decl",
      name: nameExpr.value,
      body: bodyExpr,
      visibility,
    };
  }
  return {
    kind: "unsupported-mod-decl",
    visibility,
  };
};

export const classifyTopLevelDecl = (
  form: Form,
): TopLevelDeclClassification => {
  const { visibility, keywordExpr, offset } = visibilityAndKeywordFor(form);
  const keyword =
    isIdentifierAtom(keywordExpr) ? keywordExpr.value : undefined;

  if (keyword === "use") {
    const pathExpr = form.at(offset + 1);
    if (!pathExpr) {
      return { kind: "other" };
    }
    return { kind: "use-decl", pathExpr, visibility };
  }

  if (keyword === "mod") {
    return classifyModDecl({ form, visibility, offset });
  }

  if (keyword && MACRO_DECL_KEYWORDS.has(keyword)) {
    return {
      kind: "macro-decl",
      visibility,
    };
  }

  if (
    visibility === "pub" &&
    keyword &&
    PUB_DECL_KEYWORDS.has(keyword)
  ) {
    return { kind: "other" };
  }

  if (visibility === "pub" && isUsePathExpr(form.at(1))) {
    return {
      kind: "use-decl",
      pathExpr: form.at(1)!,
      visibility,
    };
  }

  return { kind: "other" };
};

export const parseTopLevelUseDecl = (
  form: Form,
): ParsedTopLevelUseDecl | null => {
  const classified = classifyTopLevelDecl(form);
  if (classified.kind !== "use-decl") {
    return null;
  }
  return {
    pathExpr: classified.pathExpr,
    visibility: classified.visibility,
  };
};
