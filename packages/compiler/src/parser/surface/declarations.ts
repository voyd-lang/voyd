import {
  type Expr,
  Form,
  IdentifierAtom,
  type Syntax,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
} from "../ast/index.js";
import type {
  CompilerContractAttribute,
  EffectAttribute,
  IntrinsicAttribute,
} from "../attributes.js";
import { ParserSyntaxError } from "../errors.js";
import { normalizeNestedFunctionTypeAnnotation } from "./function-type-annotations.js";

export type SurfaceVisibility = {
  level: "object" | "module" | "package" | "public";
  api?: boolean;
};
export type SurfaceMemberModifier = "api" | "pri";
export type SurfaceBindingKind = "value" | "mutable-ref" | "immutable-ref";

type HirVisibility = SurfaceVisibility;
type HirMemberModifier = SurfaceMemberModifier;
type HirBindingKind = SurfaceBindingKind;

const moduleVisibility = (): SurfaceVisibility => ({ level: "module" });
const packageVisibility = (): SurfaceVisibility => ({ level: "package" });

const isIdentifierWithValue = (
  expr: Expr | undefined,
  value: string,
): expr is IdentifierAtom => isIdentifierAtom(expr) && expr.value === value;

const ensureForm = (expr: Expr | undefined, message: string): Form => {
  if (!isForm(expr)) throw new ParserSyntaxError(message, expr?.location);
  return expr;
};

export interface ParsedFunctionDecl {
  form: Form;
  visibility: HirVisibility;
  memberModifier?: HirMemberModifier;
  signature: ParsedFunctionSignature;
  body: Expr;
  intrinsic?: IntrinsicAttribute;
  compilerContract?: CompilerContractAttribute;
}

export interface ParsedModuleLetDecl {
  form: Form;
  visibility: HirVisibility;
  name: IdentifierAtom;
  initializer: Expr;
  typeExpr?: Expr;
}

export interface ParsedTypeAliasDecl {
  form: Form;
  visibility: HirVisibility;
  name: IdentifierAtom;
  target: Expr;
  typeParameters: readonly ParsedTypeParameter[];
}

export interface ParsedObjectDecl {
  form: Form;
  visibility: HirVisibility;
  objectKind: "obj" | "value";
  name: IdentifierAtom;
  base?: Expr;
  body: Form;
  fields: readonly ParsedObjectField[];
  typeParameters: readonly ParsedTypeParameter[];
}

export interface ParsedObjectField {
  name: IdentifierAtom;
  typeExpr: Expr;
  optional?: boolean;
  ast: Syntax;
  memberModifier?: HirMemberModifier;
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
  typeParameters: readonly ParsedTypeParameter[];
  methods: readonly ParsedTraitMethod[];
}

export interface ParsedImplDecl {
  form: Form;
  visibility: HirVisibility;
  target: Expr;
  trait?: Expr;
  typeParameters: readonly ParsedTypeParameter[];
  body: Form;
  methods: readonly ParsedFunctionDecl[];
}

export interface ParsedEffectOperation {
  form: Form;
  name: IdentifierAtom;
  params: SignatureParam[];
  resumable: "resume" | "tail";
  returnType?: Expr;
}

export interface ParsedEffectDecl {
  form: Form;
  visibility: HirVisibility;
  name: IdentifierAtom;
  typeParameters: readonly ParsedTypeParameter[];
  operations: readonly ParsedEffectOperation[];
  effectId?: string;
}

export interface ParsedTypeParameter {
  name: IdentifierAtom;
  constraint?: Expr;
}

interface ParsedFunctionSignature {
  name: IdentifierAtom;
  params: SignatureParam[];
  returnType?: Expr;
  typeParameters: readonly ParsedTypeParameter[];
  effectType?: Expr;
}

interface SignatureParam {
  name: string;
  label?: string;
  labelAst?: Syntax;
  ast: Syntax;
  typeExpr?: Expr;
  optional?: boolean;
  defaultValue?: Expr;
  bindingKind?: HirBindingKind;
}

export const parseFunctionDecl = (form: Form): ParsedFunctionDecl | null => {
  let index = 0;
  let visibility: HirVisibility = moduleVisibility();
  let memberModifier: HirMemberModifier | undefined;
  const first = form.at(0);

  if (isIdentifierWithValue(first, "pub")) {
    visibility = packageVisibility();
    index += 1;
  } else if (isIdentifierWithValue(first, "api")) {
    memberModifier = "api";
    index += 1;
  } else if (
    isIdentifierWithValue(first, "pri") ||
    isIdentifierWithValue(first, "#")
  ) {
    memberModifier = "pri";
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
    throw new ParserSyntaxError("fn missing signature", form.location);
  }

  const signatureForm = ensureForm(
    signatureExpr,
    "fn signature must be a form",
  );
  const signature = parseFunctionSignature(signatureForm);
  if (!bodyExpr && form.attributes?.external) {
    const args = signature.params.map((param) => {
      const value = new IdentifierAtom(param.name);
      return param.label
        ? new Form([
            new IdentifierAtom(":"),
            new IdentifierAtom(param.label),
            value,
          ]).toCall()
        : value;
    });
    bodyExpr = new Form([new IdentifierAtom(signature.name.value), ...args]).toCall();
  }
  if (!bodyExpr) {
    throw new ParserSyntaxError("fn missing body expression", form.location);
  }

  return {
    form,
    visibility,
    memberModifier,
    signature,
    body: bodyExpr,
    intrinsic: normalizeIntrinsicAttribute(
      form.attributes?.intrinsic as IntrinsicAttribute | undefined,
      signature.name.value,
    ),
    compilerContract: form.attributes?.compilerContract as
      | CompilerContractAttribute
      | undefined,
  };
};

const parseTraitMethod = (form: Form): ParsedTraitMethod => {
  if (form.attributes?.compilerContract) {
    throw new ParserSyntaxError(
      "@compiler_contract can only annotate ordinary top-level functions",
      form.location,
    );
  }
  const keyword = form.at(0);
  if (!isIdentifierWithValue(keyword, "fn")) {
    throw new ParserSyntaxError(
      "trait methods must start with 'fn'",
      form.location,
    );
  }

  let signatureExpr: Expr | undefined = form.at(1);
  let bodyExpr: Expr | undefined = form.at(2);

  if (!bodyExpr && isForm(signatureExpr) && signatureExpr.calls("=")) {
    bodyExpr = signatureExpr.at(2);
    signatureExpr = signatureExpr.at(1);
  }

  if (!signatureExpr) {
    throw new ParserSyntaxError(
      "trait method missing signature",
      form.location,
    );
  }

  const signatureForm = ensureForm(
    signatureExpr,
    "fn signature must be a form",
  );
  const signature = parseFunctionSignature(signatureForm);

  return {
    form,
    signature,
    body: bodyExpr,
    intrinsic: normalizeIntrinsicAttribute(
      form.attributes?.intrinsic as IntrinsicAttribute | undefined,
      signature.name.value,
    ),
  };
};

export const parseTypeAliasDecl = (form: Form): ParsedTypeAliasDecl | null => {
  let index = 0;
  let visibility: HirVisibility = moduleVisibility();
  const first = form.at(0);

  if (isIdentifierWithValue(first, "pub")) {
    visibility = packageVisibility();
    index += 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierWithValue(keyword, "type")) {
    return null;
  }

  const assignment = form.at(index + 1);
  if (!isForm(assignment) || !assignment.calls("=")) {
    throw new ParserSyntaxError(
      "type declaration expects an assignment",
      assignment?.location ?? form.location,
    );
  }

  const head = assignment.at(1);
  const { name, typeParameters } = parseNamedTypeHead(head);

  const target = assignment.at(2);
  if (!target) {
    throw new ParserSyntaxError(
      "type declaration missing target expression",
      assignment.location,
    );
  }

  return { form, visibility, name, target, typeParameters };
};

export const parseModuleLetDecl = (form: Form): ParsedModuleLetDecl | null => {
  let index = 0;
  let visibility: HirVisibility = moduleVisibility();
  const first = form.at(0);

  if (isIdentifierWithValue(first, "pub")) {
    visibility = packageVisibility();
    index += 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierWithValue(keyword, "let")) {
    return null;
  }

  const rawAssignment = form.at(index + 1);
  const assignment = ensureForm(
    rawAssignment,
    "module-level let declaration expects an assignment",
  );
  if (!assignment.calls("=")) {
    throw new ParserSyntaxError(
      "module-level let declaration must be an assignment form",
      assignment.location,
    );
  }

  const pattern = assignment.at(1);
  const initializer = assignment.at(2);
  if (!initializer) {
    throw new ParserSyntaxError(
      "module-level let declaration missing initializer",
      assignment.location,
    );
  }

  const { name, typeExpr } = parseModuleLetPattern(pattern);
  return {
    form,
    visibility,
    name,
    initializer,
    typeExpr,
  };
};

export const parseObjectDecl = (form: Form): ParsedObjectDecl | null => {
  let index = 0;
  let visibility: HirVisibility = moduleVisibility();
  const first = form.at(0);

  if (isIdentifierWithValue(first, "pub")) {
    visibility = packageVisibility();
    index += 1;
  }

  const keyword = form.at(index);
  const objectKind = isIdentifierWithValue(keyword, "obj")
    ? "obj"
    : isIdentifierWithValue(keyword, "val")
      ? "value"
      : undefined;
  if (!objectKind) {
    return null;
  }

  const headExpr = form.at(index + 1);
  const bodyExpr = form.at(index + 2);
  const body =
    bodyExpr && isForm(bodyExpr) && bodyExpr.callsInternal("object_literal")
      ? bodyExpr
      : undefined;

  const extractedFromHead = headExpr
    ? extractTrailingObjectLiteral(headExpr)
    : undefined;

  const extractedFromBase =
    !body &&
    !extractedFromHead &&
    isForm(headExpr) &&
    headExpr.calls(":") &&
    headExpr.length === 3
      ? extractTrailingObjectLiteral(headExpr.at(2))
      : undefined;

  const head = extractedFromHead
    ? extractedFromHead.expr
    : extractedFromBase && isForm(headExpr)
      ? new Form({
          location: headExpr.location?.clone(),
          elements: [headExpr.first!, headExpr.at(1)!, extractedFromBase.expr],
        })
      : headExpr;

  const resolvedBody =
    body ?? extractedFromHead?.literal ?? extractedFromBase?.literal;

  if (!head || !resolvedBody) {
    throw new ParserSyntaxError(
      `${objectKind} declaration requires a field list`,
      headExpr?.location ?? form.location,
    );
  }

  const { name, base, typeParameters } = parseObjectHead(head, objectKind);
  const fields = parseObjectFields(resolvedBody);

  return {
    form,
    visibility,
    objectKind,
    name,
    base,
    body: resolvedBody,
    fields,
    typeParameters,
  };
};

const extractTrailingObjectLiteral = (
  expr: Expr | undefined,
): { expr: Expr; literal: Form } | undefined => {
  if (!expr || !isForm(expr)) return undefined;
  const last = expr.last;
  if (!isForm(last) || !last.callsInternal("object_literal")) {
    return undefined;
  }
  const trimmed = expr.slice(0, -1).unwrap();
  return { expr: trimmed, literal: last };
};

export const parseTraitDecl = (form: Form): ParsedTraitDecl | null => {
  let index = 0;
  let visibility: HirVisibility = moduleVisibility();
  const first = form.at(0);

  if (isIdentifierWithValue(first, "pub")) {
    visibility = packageVisibility();
    index += 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierWithValue(keyword, "trait")) {
    return null;
  }

  const head = form.at(index + 1);
  if (!head) {
    throw new ParserSyntaxError(
      "trait declaration missing name",
      form.location,
    );
  }
  const { name, typeParameters } = parseNamedTypeHead(head);

  const body = ensureForm(
    form.at(index + 2),
    "trait declaration requires a body block",
  );
  if (!body.calls("block")) {
    throw new ParserSyntaxError("trait body must be a block", body.location);
  }

  const methods = body.rest.map((entry) => {
    if (!isForm(entry)) {
      throw new ParserSyntaxError(
        "trait body supports only function declarations",
        entry.location,
      );
    }
    return parseTraitMethod(entry);
  });

  return { form, visibility, name, body, typeParameters, methods };
};

export const parseImplDecl = (form: Form): ParsedImplDecl | null => {
  let index = 0;
  let visibility: HirVisibility = moduleVisibility();
  const first = form.at(0);

  if (isIdentifierWithValue(first, "pub")) {
    visibility = packageVisibility();
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
    throw new ParserSyntaxError(
      "impl declaration missing target type",
      form.location,
    );
  }

  if (!isForm(body) || !body.calls("block")) {
    throw new ParserSyntaxError(
      "impl body must be a block",
      body?.location ?? form.location,
    );
  }

  const { target, trait, typeParameters } = parseImplHead(headEntries);
  const methods = body.rest.map((entry) => {
    if (!isForm(entry)) {
      throw new ParserSyntaxError(
        "impl body supports only function declarations",
        entry.location,
      );
    }
    const method = parseFunctionDecl(entry);
    if (!method) {
      throw new ParserSyntaxError(
        "impl body supports only function declarations",
        entry.location,
      );
    }
    return method;
  });

  return { form, visibility, target, trait, typeParameters, body, methods };
};

const parseFunctionSignature = (form: Form): ParsedFunctionSignature => {
  const effectTail = form.calls(":") ? form.at(2) : undefined;
  if (form.calls(":") && isForm(effectTail) && effectTail.calls("->")) {
    const head = parseFunctionHead(form.at(1));
    return {
      name: head.name,
      typeParameters: head.typeParameters,
      params: head.params.flatMap(parseParameter),
      effectType: effectTail.at(1),
      returnType: effectTail.at(2),
    };
  }

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
  fnName: string,
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
  expr: Expr | undefined,
): {
  name: IdentifierAtom;
  typeParameters: readonly ParsedTypeParameter[];
  params: readonly Expr[];
} => {
  if (!expr) {
    throw new ParserSyntaxError("fn missing name");
  }

  if (isIdentifierAtom(expr)) {
    return { name: expr, typeParameters: [], params: [] };
  }

  if (isForm(expr)) {
    const nameExpr = expr.at(0);
    if (!isIdentifierAtom(nameExpr)) {
      throw new ParserSyntaxError(
        "fn name must be an identifier",
        nameExpr?.location ?? expr.location,
      );
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

  throw new ParserSyntaxError("fn name must be an identifier", expr.location);
};

const parseParameter = (expr: Expr): SignatureParam | SignatureParam[] => {
  if (isIdentifierAtom(expr) && expr.value === "`") {
    throw new ParserSyntaxError(
      "backticks (`) are not valid in function parameter lists; use single quotes for operator names (e.g. fn '=='(...))",
      expr.location,
    );
  }

  if (isForm(expr) && expr.calls("`")) {
    throw new ParserSyntaxError(
      "backticks (`) are not valid in function parameter lists; use single quotes for operator names (e.g. fn '=='(...))",
      expr.location,
    );
  }

  if (isIdentifierAtom(expr)) {
    return { name: expr.value, ast: expr };
  }

  if (isForm(expr) && expr.calls("~")) {
    const { name, ast, bindingKind } = parseParamName(expr);
    return { name, ast, bindingKind };
  }

  if (isForm(expr) && expr.calls(":")) {
    return parseSingleParam(expr);
  }

  if (isForm(expr) && expr.calls("?:")) {
    return parseSingleParam(expr);
  }

  if (isForm(expr) && expr.calls("=")) {
    return parseDefaultedParam(expr);
  }

  if (isForm(expr) && expr.callsInternal("object_literal")) {
    return parseLabeledParameters(expr);
  }

  throw new ParserSyntaxError("unsupported parameter form", expr.location);
};

export const parseEffectDecl = (form: Form): ParsedEffectDecl | null => {
  let index = 0;
  let visibility: HirVisibility = moduleVisibility();
  const effectAttr = form.attributes?.effect as EffectAttribute | undefined;
  const effectId = effectAttr?.id;
  const first = form.at(0);

  if (isIdentifierWithValue(first, "pub")) {
    visibility = packageVisibility();
    index += 1;
  }

  const keyword = form.at(index);
  if (!isIdentifierWithValue(keyword, "eff")) {
    return null;
  }

  const next = form.at(index + 1);
  if (!next) {
    throw new ParserSyntaxError(
      "eff declaration missing name or operation",
      form.location,
    );
  }

  const operations: ParsedEffectOperation[] = [];
  const effectHead = (() => {
    if (isIdentifierAtom(next)) {
      return { name: next, typeParameters: [] as const };
    }
    if (
      isForm(next) &&
      isIdentifierAtom(next.at(0)) &&
      isForm(next.at(1)) &&
      formCallsInternal(next.at(1)!, "generics")
    ) {
      return parseNamedTypeHead(next);
    }
    return undefined;
  })();

  if (effectHead) {
    const body = form.at(index + 2);
    if (!body) {
      throw new ParserSyntaxError(
        "eff declaration missing body",
        form.location,
      );
    }
    if (!isForm(body) || !body.calls("block")) {
      throw new ParserSyntaxError(
        "eff declaration body must be a block",
        body.location,
      );
    }
    body.rest.forEach((entry) => {
      if (!isForm(entry)) {
        throw new ParserSyntaxError(
          "effect operations must be forms",
          entry.location,
        );
      }
      operations.push(parseEffectOperation(entry));
    });
    return {
      form,
      visibility,
      name: effectHead.name,
      typeParameters: effectHead.typeParameters,
      operations,
      effectId,
    };
  }

  if (isForm(next)) {
    const op = parseEffectOperation(next);
    return {
      form,
      visibility,
      name: op.name,
      typeParameters: [],
      operations: [op],
      effectId,
    };
  }

  throw new ParserSyntaxError("invalid eff declaration", next.location);
};

const parseEffectOperation = (form: Form): ParsedEffectOperation => {
  const opForm = form.calls("fn")
    ? ensureForm(form.at(1), "effect operation signature must be a form")
    : form;
  const signature = parseEffectOperationSignature(opForm);
  return {
    form,
    name: signature.name,
    params: signature.params,
    resumable: signature.resumable,
    returnType: signature.returnType,
  };
};

const parseEffectOperationSignature = (
  form: Form,
): {
  name: IdentifierAtom;
  params: SignatureParam[];
  resumable: "resume" | "tail";
  returnType?: Expr;
} => {
  let headExpr: Expr | undefined = form;
  let returnType: Expr | undefined;

  if (form.calls("->")) {
    headExpr = form.at(1);
    returnType = form.at(2);
  }

  if (!headExpr) {
    throw new ParserSyntaxError("effect operation missing name", form.location);
  }

  if (isIdentifierAtom(headExpr)) {
    return {
      name: headExpr,
      params: [],
      resumable: "resume",
      returnType,
    };
  }

  if (!isForm(headExpr)) {
    throw new ParserSyntaxError(
      "effect operation name must be an identifier",
      headExpr.location,
    );
  }

  const nameExpr = headExpr.at(0);
  if (!isIdentifierAtom(nameExpr)) {
    throw new ParserSyntaxError(
      "effect operation name must be an identifier",
      nameExpr?.location ?? headExpr.location,
    );
  }
  const rawParams = headExpr.rest;
  const resumableParam = rawParams[0];
  const resumable =
    isIdentifierAtom(resumableParam) &&
    (resumableParam.value === "tail" || resumableParam.value === "resume")
      ? (resumableParam.value as "resume" | "tail")
      : "resume";

  const params = rawParams
    .slice(resumable === "resume" || resumable === "tail" ? 1 : 0)
    .flatMap(parseParameter)
    .flat();
  if (params.some((param) => param.defaultValue)) {
    throw new ParserSyntaxError(
      "effect operation parameters do not support default values",
      headExpr.location,
    );
  }

  return {
    name: nameExpr,
    params,
    resumable,
    returnType,
  };
};

const parseLabeledParameters = (form: Form): SignatureParam[] =>
  form.rest.map((expr) => {
    if (isForm(expr) && expr.calls("=")) {
      const param = parseDefaultedParam(expr);
      return {
        ...param,
        label: param.name,
        labelAst: param.ast,
      };
    }

    if (isForm(expr) && (expr.calls(":") || expr.calls("?:"))) {
      const param = parseSingleParam(expr);
      return {
        ...param,
        label: param.name,
        labelAst: param.ast,
      };
    }

    if (isForm(expr) && isIdentifierAtom(expr.first) && isForm(expr.second)) {
      const labelExpr = expr.first;
      const parsed = parseParameter(expr.second);
      if (Array.isArray(parsed)) {
        throw new ParserSyntaxError(
          "labeled parameter entry cannot contain nested parameter groups",
          expr.location,
        );
      }
      return {
        label: labelExpr.value,
        labelAst: labelExpr,
        ...parsed,
      };
    }

    throw new ParserSyntaxError("unsupported parameter form", expr.location);
  });

const parseSingleParam = (expr: Form): SignatureParam => {
  const { nameExpr, typeExpr, optional } =
    normalizeNestedFunctionTypeAnnotation(expr);
  const { name, ast, bindingKind } = parseParamName(nameExpr);
  return {
    name,
    ast,
    bindingKind,
    typeExpr,
    optional,
  };
};

const parseDefaultedParam = (expr: Form): SignatureParam => {
  const targetExpr = expr.at(1);
  const defaultValue = expr.at(2);
  if (!targetExpr || !defaultValue) {
    throw new ParserSyntaxError(
      "default parameter is missing a target or default value",
      expr.location,
    );
  }

  const parsed = parseParameter(targetExpr);
  if (Array.isArray(parsed)) {
    throw new ParserSyntaxError(
      "default parameter target must be a single parameter",
      expr.location,
    );
  }
  if (parsed.optional) {
    throw new ParserSyntaxError(
      "default parameters cannot use '?'; use either '?' or '='",
      expr.location,
    );
  }

  return {
    ...parsed,
    optional: true,
    defaultValue,
  };
};

const parseParamName = (
  expr: Expr | undefined,
): { name: string; ast: Syntax; bindingKind?: HirBindingKind } => {
  if (isIdentifierAtom(expr)) {
    return { name: expr.value, ast: expr };
  }

  if (isForm(expr) && expr.calls("~")) {
    const target = expr.at(1);
    if (!isIdentifierAtom(target)) {
      throw new ParserSyntaxError(
        "parameter name must be an identifier",
        expr.location,
      );
    }
    return {
      name: target.value,
      ast: target,
      bindingKind: "mutable-ref",
    };
  }

  throw new ParserSyntaxError(
    "parameter name must be an identifier",
    expr?.location,
  );
};

const parseModuleLetPattern = (
  pattern: Expr | undefined,
): { name: IdentifierAtom; typeExpr?: Expr } => {
  if (!pattern) {
    throw new ParserSyntaxError(
      "module-level let declaration missing binding name",
    );
  }
  const { target, usesMutableRef } = unwrapMutablePattern(pattern);
  if (usesMutableRef) {
    throw new ParserSyntaxError(
      "module-level let does not support mutable object bindings ('~')",
      pattern.location,
    );
  }

  if (isIdentifierAtom(target)) {
    return { name: target };
  }

  if (isForm(target) && target.calls(":")) {
    const { nameExpr, typeExpr } =
      normalizeNestedFunctionTypeAnnotation(target);
    if (!isIdentifierAtom(nameExpr)) {
      throw new ParserSyntaxError(
        "module-level let declaration expects an identifier binding",
        nameExpr?.location ?? target.location,
      );
    }
    if (!typeExpr) {
      throw new ParserSyntaxError(
        "module-level let declaration missing type annotation",
        target.location,
      );
    }
    return { name: nameExpr, typeExpr };
  }

  throw new ParserSyntaxError(
    "module-level let declaration supports only identifier bindings",
    target.location,
  );
};

const unwrapMutablePattern = (
  pattern: Expr,
): { target: Expr; usesMutableRef: boolean } => {
  if (isForm(pattern) && pattern.calls("~")) {
    const target = pattern.at(1);
    if (!target) {
      throw new ParserSyntaxError(
        "mutable pattern is missing a target",
        pattern.location,
      );
    }
    return { target, usesMutableRef: true };
  }
  return { target: pattern, usesMutableRef: false };
};

const parseObjectHead = (
  expr: Expr | undefined,
  objectKind: "obj" | "value",
): {
  name: IdentifierAtom;
  base?: Expr;
  typeParameters: readonly ParsedTypeParameter[];
} => {
  if (!expr) {
    throw new ParserSyntaxError(`${objectKind} declaration missing name`);
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

  throw new ParserSyntaxError(
    `invalid ${objectKind} declaration head`,
    expr.location,
  );
};

const parseNamedTypeHead = (
  expr: Expr | undefined,
): { name: IdentifierAtom; typeParameters: readonly ParsedTypeParameter[] } => {
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
  throw new ParserSyntaxError("invalid named type head", expr?.location);
};

const parseTypeParameters = (form: Form): ParsedTypeParameter[] =>
  form.rest.map((entry) => {
    if (isIdentifierAtom(entry)) {
      return { name: entry };
    }

    if (isForm(entry) && entry.calls(":")) {
      const name = entry.at(1);
      if (!isIdentifierAtom(name)) {
        throw new ParserSyntaxError(
          "constrained type parameter name must be an identifier",
          name?.location ?? entry.location,
        );
      }
      const constraint = entry.at(2);
      if (!constraint) {
        throw new ParserSyntaxError(
          "constrained type parameter missing constraint type",
          entry.location,
        );
      }
      return { name, constraint };
    }

    throw new ParserSyntaxError(
      "type parameters must be identifiers or constrained identifiers",
      entry.location,
    );
  });

const parseImplHead = (
  entries: readonly Expr[],
): { target: Expr; trait?: Expr; typeParameters: ParsedTypeParameter[] } => {
  if (entries.length === 0) {
    throw new ParserSyntaxError("impl declaration missing target type");
  }

  const forIndex = entries.findIndex((entry) =>
    isIdentifierWithValue(entry, "for"),
  );
  if (forIndex !== -1) {
    if (forIndex === 0 || forIndex === entries.length - 1) {
      throw new ParserSyntaxError(
        "impl 'for' clause missing trait or target",
        entries[forIndex]?.location,
      );
    }
    const traitExpr = entries[forIndex - 1];
    const targetExpr = entries[forIndex + 1];
    if (!traitExpr || !targetExpr) {
      throw new ParserSyntaxError(
        "impl 'for' clause missing target type",
        entries[forIndex]?.location,
      );
    }

    const leading = entries.slice(0, Math.max(0, forIndex - 1));
    const trailing = entries.slice(forIndex + 2);
    let typeParameters: ParsedTypeParameter[] = [];
    leading.forEach((entry) => {
      if (isForm(entry) && formCallsInternal(entry, "generics")) {
        typeParameters = [...typeParameters, ...parseTypeParameters(entry)];
        return;
      }
      throw new ParserSyntaxError(
        "impl head contains unexpected entries",
        entry.location,
      );
    });
    if (trailing.length > 0) {
      throw new ParserSyntaxError(
        "impl head contains unexpected entries",
        trailing[0]?.location,
      );
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

  if (
    entries.length === 2 &&
    isForm(entries[0]) &&
    formCallsInternal(entries[0]!, "generics")
  ) {
    const typeParameters = parseTypeParameters(entries[0] as Form);
    const { target, typeParameters: targetParams } = parseImplHeadTarget(
      entries[1]!,
    );
    return { target, typeParameters: [...typeParameters, ...targetParams] };
  }

  if (entries.length !== 1) {
    throw new ParserSyntaxError(
      "impl declaration missing target type",
      entries[0]?.location,
    );
  }

  return parseImplHeadTarget(entries[0]!);
};

const parseImplHeadTarget = (
  expr: Expr,
): { target: Expr; typeParameters: ParsedTypeParameter[] } => {
  if (isForm(expr) && formCallsInternal(expr, "generics")) {
    const targetExpr = expr.at(1);
    if (!targetExpr) {
      throw new ParserSyntaxError(
        "impl generics must be followed by a target type",
        expr.location,
      );
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
    if (!isForm(entry)) {
      throw new ParserSyntaxError(
        "object fields must be labeled",
        entry.location,
      );
    }

    const { field, modifier } = unwrapFieldEntry(entry);
    const optional = field.calls("?:");
    if (!field.calls(":") && !optional) {
      throw new ParserSyntaxError(
        "object fields must be labeled",
        entry.location,
      );
    }
    const nameExpr = field.at(1);
    const typeExpr = field.at(2);
    if (!isIdentifierAtom(nameExpr)) {
      throw new ParserSyntaxError(
        "object field name must be an identifier",
        entry.location,
      );
    }
    if (!typeExpr) {
      throw new ParserSyntaxError("object field missing type", entry.location);
    }
    return {
      name: nameExpr,
      typeExpr,
      optional: optional ? true : undefined,
      ast: entry,
      memberModifier: modifier,
    };
  });

const unwrapFieldEntry = (
  entry: Form,
): { field: Form; modifier?: HirMemberModifier } => {
  const modifier = (() => {
    if (isIdentifierWithValue(entry.at(0), "api")) return "api";
    if (
      isIdentifierWithValue(entry.at(0), "pri") ||
      isIdentifierWithValue(entry.at(0), "#")
    ) {
      return "pri";
    }
    return undefined;
  })();

  if (!modifier) {
    return { field: entry };
  }

  const field = entry.at(1);
  if (!isForm(field)) {
    throw new ParserSyntaxError(
      "api/pri field entries must wrap a labeled field",
      entry.location,
    );
  }

  return { field, modifier };
};
