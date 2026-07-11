import {
  type Expr,
  type Form,
  type IdentifierAtom,
  type InternalIdentifierAtom,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../ast/index.js";
import { ParserSyntaxError } from "../errors.js";

export type SurfaceTryExpression = {
  form: Form;
  openUnhandled: boolean;
  bodyIndex: number;
  body: Expr;
};

export type SurfaceHandlerParameter = {
  syntax: IdentifierAtom | InternalIdentifierAtom;
  name: string;
  typeExpr?: Expr;
};

export type SurfaceHandlerHead = {
  syntax: Expr;
  effectExpr?: Expr;
  operation: IdentifierAtom | InternalIdentifierAtom;
  parameters: readonly SurfaceHandlerParameter[];
};

export type SurfaceHandlerClause = {
  form: Form;
  head: SurfaceHandlerHead;
  body: Expr;
};

const tryCache = new WeakMap<Form, SurfaceTryExpression>();
const handlerClauseCache = new WeakMap<Form, SurfaceHandlerClause>();
const handlerHeadCache = new WeakMap<object, SurfaceHandlerHead>();

export const parseSurfaceTryExpression = (form: Form): SurfaceTryExpression => {
  const cached = tryCache.get(form);
  if (cached) return cached;

  const marker = form.at(1);
  const openUnhandled = isIdentifierAtom(marker) && marker.value === "open";
  const bodyIndex = openUnhandled ? 2 : 1;
  const body = form.at(bodyIndex);
  if (!body) {
    throw new ParserSyntaxError("try expression missing body", form.location);
  }

  const parsed = { form, openUnhandled, bodyIndex, body };
  tryCache.set(form, parsed);
  return parsed;
};

export const parseSurfaceHandlerClause = (form: Form): SurfaceHandlerClause => {
  const cached = handlerClauseCache.get(form);
  if (cached) return cached;
  if (!form.calls(":")) {
    throw new ParserSyntaxError(
      "effect handler clause must be labeled with ':'",
      form.location,
    );
  }
  const headExpr = form.at(1);
  const body = form.at(2);
  if (!headExpr) {
    throw new ParserSyntaxError("effect handler missing head", form.location);
  }
  if (!body) {
    throw new ParserSyntaxError(
      "effect handler clause missing body",
      form.location,
    );
  }

  const parsed = {
    form,
    head: parseSurfaceHandlerHead(headExpr),
    body,
  };
  handlerClauseCache.set(form, parsed);
  return parsed;
};

export const parseSurfaceHandlerHead = (expr: Expr): SurfaceHandlerHead => {
  const cached = handlerHeadCache.get(expr);
  if (cached) return cached;

  const effectExpr = isForm(expr) && expr.calls("::") ? expr.at(1) : undefined;
  const operationCall = effectExpr && isForm(expr) ? expr.at(2) : expr;
  if (!operationCall) {
    throw new ParserSyntaxError(
      "handler head missing operation",
      expr.location,
    );
  }

  const operation = isForm(operationCall) ? operationCall.at(0) : operationCall;
  if (!isIdentifierAtom(operation) && !isInternalIdentifierAtom(operation)) {
    throw new ParserSyntaxError(
      "handler operation must be an identifier",
      operation?.location ?? operationCall.location,
    );
  }

  const parameters = isForm(operationCall)
    ? operationCall.rest.map(parseHandlerParameter)
    : [];
  const parsed = {
    syntax: expr,
    ...(effectExpr ? { effectExpr } : {}),
    operation,
    parameters,
  } satisfies SurfaceHandlerHead;
  handlerHeadCache.set(expr, parsed);
  return parsed;
};

const parseHandlerParameter = (expr: Expr): SurfaceHandlerParameter => {
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    return { syntax: expr, name: expr.value };
  }
  if (isForm(expr) && expr.calls(":")) {
    const name = expr.at(1);
    const typeExpr = expr.at(2);
    if (
      (isIdentifierAtom(name) || isInternalIdentifierAtom(name)) &&
      typeExpr &&
      expr.length === 3
    ) {
      return { syntax: name, name: name.value, typeExpr };
    }
  }
  throw new ParserSyntaxError(
    "handler parameter must be an identifier or typed identifier",
    expr.location,
  );
};
