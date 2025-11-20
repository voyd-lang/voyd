import {
  type Expr,
  type Form,
  type IdentifierAtom,
  type Syntax,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
} from "../../parser/index.js";
import type { HirVisibility } from "../hir/index.js";
import { isIdentifierWithValue } from "../utils.js";

export interface ParsedFunctionDecl {
  form: Form;
  visibility: HirVisibility;
  signature: ParsedFunctionSignature;
  body: Expr;
}

export interface ParsedTypeAliasDecl {
  form: Form;
  visibility: HirVisibility;
  name: IdentifierAtom;
  target: Expr;
}

export interface ParsedObjectDecl {
  form: Form;
  visibility: HirVisibility;
  name: IdentifierAtom;
  base?: Expr;
  body: Form;
  fields: readonly ParsedObjectField[];
  typeParameters: readonly IdentifierAtom[];
}

export interface ParsedObjectField {
  name: IdentifierAtom;
  typeExpr: Expr;
  ast: Syntax;
}

interface ParsedFunctionSignature {
  name: IdentifierAtom;
  params: SignatureParam[];
  returnType?: Expr;
}

interface SignatureParam {
  name: string;
  label?: string;
  ast: Syntax;
  typeExpr?: Expr;
}

export const parseFunctionDecl = (form: Form): ParsedFunctionDecl | null => {
  let index = 0;
  let visibility: HirVisibility = "module";
  const first = form.at(0);

  if (isIdentifierWithValue(first, "pub")) {
    visibility = "public";
    index += 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierWithValue(keyword, "fn")) {
    return null;
  }

  let signatureExpr: Expr | undefined = form.at(index + 1);
  let bodyExpr: Expr | undefined = form.at(index + 2);

  if (!bodyExpr && isForm(signatureExpr) && signatureExpr.calls("=")) {
    bodyExpr = signatureExpr.at(2);
    signatureExpr = signatureExpr.at(1);
  }

  if (!signatureExpr) {
    throw new Error("fn missing signature");
  }

  if (!bodyExpr) {
    throw new Error("fn missing body expression");
  }

  const signatureForm = ensureForm(
    signatureExpr,
    "fn signature must be a form"
  );
  const signature = parseFunctionSignature(signatureForm);

  return {
    form,
    visibility,
    signature,
    body: bodyExpr,
  };
};

export const parseTypeAliasDecl = (form: Form): ParsedTypeAliasDecl | null => {
  let index = 0;
  let visibility: HirVisibility = "module";
  const first = form.at(0);

  if (isIdentifierWithValue(first, "pub")) {
    visibility = "public";
    index += 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierWithValue(keyword, "type")) {
    return null;
  }

  const assignment = form.at(index + 1);
  if (!isForm(assignment) || !assignment.calls("=")) {
    throw new Error("type declaration expects an assignment");
  }

  const nameExpr = assignment.at(1);
  if (!isIdentifierAtom(nameExpr)) {
    throw new Error("type name must be an identifier");
  }

  const target = assignment.at(2);
  if (!target) {
    throw new Error("type declaration missing target expression");
  }

  return { form, visibility, name: nameExpr, target };
};

export const parseObjectDecl = (form: Form): ParsedObjectDecl | null => {
  let index = 0;
  let visibility: HirVisibility = "module";
  const first = form.at(0);

  if (isIdentifierWithValue(first, "pub")) {
    visibility = "public";
    index += 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierWithValue(keyword, "obj")) {
    return null;
  }

  const head = form.at(index + 1);
  const body = form.at(index + 2);
  if (!body || !isForm(body) || !body.callsInternal("object_literal")) {
    throw new Error("obj declaration requires a field list");
  }

  const { name, base, typeParameters } = parseObjectHead(head);
  const fields = parseObjectFields(body);

  return { form, visibility, name, base, body, fields, typeParameters };
};

const parseFunctionSignature = (form: Form): ParsedFunctionSignature => {
  if (form.calls("->")) {
    const head = parseFunctionHead(form.at(1));
    return {
      name: head.name,
      params: head.params.flatMap(parseParameter),
      returnType: form.at(2),
    };
  }

  const head = parseFunctionHead(form);
  return {
    name: head.name,
    params: head.params.flatMap(parseParameter),
  };
};

const parseFunctionHead = (
  expr: Expr | undefined
): { name: IdentifierAtom; params: readonly Expr[] } => {
  if (!expr) {
    throw new Error("fn missing name");
  }

  if (isIdentifierAtom(expr)) {
    return { name: expr, params: [] };
  }

  if (isForm(expr)) {
    const nameExpr = expr.at(0);
    if (!isIdentifierAtom(nameExpr)) {
      throw new Error("fn name must be an identifier");
    }
    return { name: nameExpr, params: expr.rest };
  }

  throw new Error("fn name must be an identifier");
};

const parseParameter = (expr: Expr): SignatureParam | SignatureParam[] => {
  if (isIdentifierAtom(expr)) {
    return { name: expr.value, ast: expr };
  }

  if (isForm(expr) && expr.calls(":")) {
    return parseSingleParam(expr);
  }

  if (isForm(expr) && expr.callsInternal("object_literal")) {
    return parseLabeledParameters(expr);
  }

  throw new Error("unsupported parameter form");
};

const parseLabeledParameters = (form: Form): SignatureParam[] =>
  form.rest.map((expr) => {
    if (isForm(expr) && expr.calls(":")) {
      const param = parseSingleParam(expr);
      return {
        ...param,
        label: param.name,
      };
    }

    if (
      isForm(expr) &&
      isIdentifierAtom(expr.first) &&
      isForm(expr.second) &&
      expr.second.calls(":")
    ) {
      const labelExpr = expr.first;
      return {
        label: labelExpr.value,
        ...parseSingleParam(expr.second),
      };
    }

    throw new Error("unsupported parameter form");
  });

const parseSingleParam = (expr: Form): SignatureParam => {
  const nameExpr = expr.at(1);
  if (!isIdentifierAtom(nameExpr)) {
    throw new Error("parameter name must be an identifier");
  }
  return {
    name: nameExpr.value,
    ast: nameExpr,
    typeExpr: expr.at(2),
  };
};

const parseObjectHead = (
  expr: Expr | undefined
): {
  name: IdentifierAtom;
  base?: Expr;
  typeParameters: readonly IdentifierAtom[];
} => {
  if (!expr) {
    throw new Error("obj declaration missing name");
  }

  if (isIdentifierAtom(expr)) {
    return { name: expr, typeParameters: [] };
  }

  if (isForm(expr) && expr.calls(":")) {
    const nameExpr = expr.at(1);
    const baseExpr = expr.at(2);
    const { name, typeParameters } = parseNamedTypeHead(nameExpr);
    return { name, base: baseExpr, typeParameters };
  }

  if (isForm(expr)) {
    return parseNamedTypeHead(expr);
  }

  throw new Error("invalid obj declaration head");
};

const parseNamedTypeHead = (
  expr: Expr | undefined
): { name: IdentifierAtom; typeParameters: readonly IdentifierAtom[] } => {
  if (isIdentifierAtom(expr)) {
    return { name: expr, typeParameters: [] };
  }
  if (
    isForm(expr) &&
    isIdentifierAtom(expr.at(0)) &&
    isForm(expr.at(1)) &&
    formCallsInternal(expr.at(1)!, "generics")
  ) {
    const name = expr.at(0) as IdentifierAtom;
    const generics = expr.at(1) as Form;
    return { name, typeParameters: parseTypeParameters(generics) };
  }
  throw new Error("invalid named type head");
};

const parseTypeParameters = (form: Form): IdentifierAtom[] =>
  form.rest.map((entry) => {
    if (!isIdentifierAtom(entry)) {
      throw new Error("type parameters must be identifiers");
    }
    return entry;
  });

const parseObjectFields = (body: Form): ParsedObjectField[] =>
  body.rest.map((entry) => {
    if (!isForm(entry) || !entry.calls(":")) {
      throw new Error("object fields must be labeled");
    }
    const nameExpr = entry.at(1);
    const typeExpr = entry.at(2);
    if (!isIdentifierAtom(nameExpr)) {
      throw new Error("object field name must be an identifier");
    }
    if (!typeExpr) {
      throw new Error("object field missing type");
    }
    return { name: nameExpr, typeExpr, ast: entry };
  });

const ensureForm = (expr: Expr | undefined, message: string): Form => {
  if (!isForm(expr)) {
    throw new Error(message);
  }
  return expr;
};
