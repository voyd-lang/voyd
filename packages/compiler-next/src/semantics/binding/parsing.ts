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
import type { IntrinsicAttribute } from "../../parser/attributes.js";
import type { HirBindingKind } from "../hir/index.js";

export interface ParsedFunctionDecl {
  form: Form;
  visibility: HirVisibility;
  signature: ParsedFunctionSignature;
  body: Expr;
  intrinsic?: IntrinsicAttribute;
}

export interface ParsedTypeAliasDecl {
  form: Form;
  visibility: HirVisibility;
  name: IdentifierAtom;
  target: Expr;
  typeParameters: readonly IdentifierAtom[];
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

export interface ParsedTraitMethod {
  form: Form;
  signature: ParsedFunctionSignature;
  body?: Expr;
  intrinsic?: IntrinsicAttribute;
}

export interface ParsedTraitDecl {
  form: Form;
  visibility: HirVisibility;
  name: IdentifierAtom;
  body: Form;
  typeParameters: readonly IdentifierAtom[];
  methods: readonly ParsedTraitMethod[];
}

export interface ParsedImplDecl {
  form: Form;
  visibility: HirVisibility;
  target: Expr;
  trait?: Expr;
  typeParameters: readonly IdentifierAtom[];
  body: Form;
}

interface ParsedFunctionSignature {
  name: IdentifierAtom;
  params: SignatureParam[];
  returnType?: Expr;
  typeParameters: readonly IdentifierAtom[];
}

interface SignatureParam {
  name: string;
  label?: string;
  ast: Syntax;
  typeExpr?: Expr;
   bindingKind?: HirBindingKind;
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
    intrinsic: normalizeIntrinsicAttribute(
      form.attributes?.intrinsic as IntrinsicAttribute | undefined,
      signature.name.value
    ),
  };
};

const parseTraitMethod = (form: Form): ParsedTraitMethod => {
  const keyword = form.at(0);
  if (!isIdentifierWithValue(keyword, "fn")) {
    throw new Error("trait methods must start with 'fn'");
  }

  let signatureExpr: Expr | undefined = form.at(1);
  let bodyExpr: Expr | undefined = form.at(2);

  if (!bodyExpr && isForm(signatureExpr) && signatureExpr.calls("=")) {
    bodyExpr = signatureExpr.at(2);
    signatureExpr = signatureExpr.at(1);
  }

  if (!signatureExpr) {
    throw new Error("trait method missing signature");
  }

  const signatureForm = ensureForm(
    signatureExpr,
    "fn signature must be a form"
  );
  const signature = parseFunctionSignature(signatureForm);

  return {
    form,
    signature,
    body: bodyExpr,
    intrinsic: normalizeIntrinsicAttribute(
      form.attributes?.intrinsic as IntrinsicAttribute | undefined,
      signature.name.value
    ),
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

  const head = assignment.at(1);
  const { name, typeParameters } = parseNamedTypeHead(head);

  const target = assignment.at(2);
  if (!target) {
    throw new Error("type declaration missing target expression");
  }

  return { form, visibility, name, target, typeParameters };
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

export const parseTraitDecl = (form: Form): ParsedTraitDecl | null => {
  let index = 0;
  let visibility: HirVisibility = "module";
  const first = form.at(0);

  if (isIdentifierWithValue(first, "pub")) {
    visibility = "public";
    index += 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierWithValue(keyword, "trait")) {
    return null;
  }

  const head = form.at(index + 1);
  if (!head) {
    throw new Error("trait declaration missing name");
  }
  const { name, typeParameters } = parseNamedTypeHead(head);

  const body = ensureForm(
    form.at(index + 2),
    "trait declaration requires a body block"
  );
  if (!body.calls("block")) {
    throw new Error("trait body must be a block");
  }

  const methods = body.rest.map((entry) => {
    if (!isForm(entry)) {
      throw new Error("trait body supports only function declarations");
    }
    return parseTraitMethod(entry);
  });

  return { form, visibility, name, body, typeParameters, methods };
};

export const parseImplDecl = (form: Form): ParsedImplDecl | null => {
  let index = 0;
  let visibility: HirVisibility = "module";
  const first = form.at(0);

  if (isIdentifierWithValue(first, "pub")) {
    visibility = "public";
    index += 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierWithValue(keyword, "impl")) {
    return null;
  }

  const headEntries: Expr[] = [];
  let body: Expr | undefined;
  for (let entryIndex = index + 1; entryIndex < form.length; entryIndex += 1) {
    const entry = form.at(entryIndex);
    if (isForm(entry) && entry.calls("block")) {
      body = entry;
      break;
    }
    if (!entry) {
      continue;
    }
    headEntries.push(entry);
  }

  if (headEntries.length === 0) {
    throw new Error("impl declaration missing target type");
  }

  if (!isForm(body) || !body.calls("block")) {
    throw new Error("impl body must be a block");
  }

  const { target, trait, typeParameters } = parseImplHead(headEntries);

  return { form, visibility, target, trait, typeParameters, body };
};

const parseFunctionSignature = (form: Form): ParsedFunctionSignature => {
  if (form.calls("->")) {
    const head = parseFunctionHead(form.at(1));
    return {
      name: head.name,
      typeParameters: head.typeParameters,
      params: head.params.flatMap(parseParameter),
      returnType: form.at(2),
    };
  }

  const head = parseFunctionHead(form);
  return {
    name: head.name,
    typeParameters: head.typeParameters,
    params: head.params.flatMap(parseParameter),
  };
};

export const normalizeIntrinsicAttribute = (
  attr: IntrinsicAttribute | undefined,
  fnName: string
): IntrinsicAttribute | undefined => {
  if (!attr) {
    return undefined;
  }

  return {
    name: attr.name ?? fnName,
    usesSignature: attr.usesSignature ?? false,
  };
};

const parseFunctionHead = (
  expr: Expr | undefined
): {
  name: IdentifierAtom;
  typeParameters: readonly IdentifierAtom[];
  params: readonly Expr[];
} => {
  if (!expr) {
    throw new Error("fn missing name");
  }

  if (isIdentifierAtom(expr)) {
    return { name: expr, typeParameters: [], params: [] };
  }

  if (isForm(expr)) {
    const nameExpr = expr.at(0);
    if (!isIdentifierAtom(nameExpr)) {
      throw new Error("fn name must be an identifier");
    }
    const potentialGenerics = expr.at(1);
    const hasGenerics =
      isForm(potentialGenerics) &&
      formCallsInternal(potentialGenerics, "generics");
    const params = hasGenerics ? expr.rest.slice(1) : expr.rest;
    return {
      name: nameExpr,
      typeParameters: hasGenerics
        ? parseTypeParameters(potentialGenerics as Form)
        : [],
      params,
    };
  }

  throw new Error("fn name must be an identifier");
};

const parseParameter = (expr: Expr): SignatureParam | SignatureParam[] => {
  if (isIdentifierAtom(expr)) {
    return { name: expr.value, ast: expr };
  }

  if (isForm(expr) && expr.calls("&")) {
    const { name, ast, bindingKind } = parseParamName(expr);
    return { name, ast, bindingKind };
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
  const { name, ast, bindingKind } = parseParamName(nameExpr);
  return {
    name,
    ast,
    bindingKind,
    typeExpr: expr.at(2),
  };
};

const parseParamName = (
  expr: Expr | undefined
): { name: string; ast: Syntax; bindingKind?: HirBindingKind } => {
  if (isIdentifierAtom(expr)) {
    return { name: expr.value, ast: expr };
  }

  if (isForm(expr) && expr.calls("&")) {
    const target = expr.at(1);
    if (!isIdentifierAtom(target)) {
      throw new Error("parameter name must be an identifier");
    }
    return {
      name: target.value,
      ast: target,
      bindingKind: "mutable-ref",
    };
  }

  throw new Error("parameter name must be an identifier");
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

const parseImplHead = (
  entries: readonly Expr[]
): { target: Expr; trait?: Expr; typeParameters: IdentifierAtom[] } => {
  if (entries.length === 0) {
    throw new Error("impl declaration missing target type");
  }

  const forIndex = entries.findIndex((entry) =>
    isIdentifierWithValue(entry, "for")
  );
  if (forIndex !== -1) {
    if (forIndex === 0 || forIndex === entries.length - 1) {
      throw new Error("impl 'for' clause missing trait or target");
    }
    const traitExpr = entries[forIndex - 1];
    const targetExpr = entries[forIndex + 1];
    if (!traitExpr || !targetExpr) {
      throw new Error("impl 'for' clause missing target type");
    }

    const leading = entries.slice(0, Math.max(0, forIndex - 1));
    const trailing = entries.slice(forIndex + 2);
    let typeParameters: IdentifierAtom[] = [];
    leading.forEach((entry) => {
      if (isForm(entry) && formCallsInternal(entry, "generics")) {
        typeParameters = [...typeParameters, ...parseTypeParameters(entry)];
        return;
      }
      throw new Error("impl head contains unexpected entries");
    });
    if (trailing.length > 0) {
      throw new Error("impl head contains unexpected entries");
    }

    const trait = parseImplHeadTarget(traitExpr);
    const target = parseImplHeadTarget(targetExpr);

    return {
      trait: trait.target,
      target: target.target,
      typeParameters: [
        ...typeParameters,
        ...trait.typeParameters,
        ...target.typeParameters,
      ],
    };
  }

  if (entries.length !== 1) {
    throw new Error("impl declaration missing target type");
  }

  return parseImplHeadTarget(entries[0]!);
};

const parseImplHeadTarget = (
  expr: Expr
): { target: Expr; typeParameters: IdentifierAtom[] } => {
  if (isForm(expr) && formCallsInternal(expr, "generics")) {
    const targetExpr = expr.at(1);
    if (!targetExpr) {
      throw new Error("impl generics must be followed by a target type");
    }
    return {
      target: targetExpr,
      typeParameters: parseTypeParameters(expr),
    };
  }

  if (isForm(expr) && isIdentifierAtom(expr.first) && isForm(expr.second)) {
    const generics = expr.second;
    if (formCallsInternal(generics, "generics")) {
      return {
        target: expr,
        typeParameters: [],
      };
    }
  }

  return { target: expr, typeParameters: [] };
};

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
