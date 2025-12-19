import {
  type Expr,
  type Form,
  type Syntax,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
} from "../../parser/index.js";
import { toSourceSpan } from "../utils.js";
import type {
  HirRecordTypeField,
  HirTypeExpr,
  HirFunctionTypeExpr,
  HirTypeParameter,
} from "../hir/index.js";
import { resolveTypeSymbol } from "./resolution.js";
import type { LowerContext } from "./types.js";
import type { ScopeId, SymbolId } from "../ids.js";
import { parseLambdaSignature } from "../lambda.js";

export const lowerTypeExpr = (
  expr: Expr | undefined,
  ctx: LowerContext,
  scope?: ScopeId
): HirTypeExpr | undefined => {
  if (!expr) return undefined;

  const currentScope = scope ?? ctx.symbolTable.rootScope;

  if (isForm(expr) && expr.length === 0) {
    return {
      typeKind: "tuple",
      ast: expr.syntaxId,
      span: toSourceSpan(expr),
      elements: [],
    };
  }

  if (isIdentifierAtom(expr)) {
    return lowerNamedType(expr, ctx, currentScope);
  }

  if (isForm(expr) && isObjectTypeForm(expr)) {
    return lowerObjectTypeExpr(expr, ctx, currentScope);
  }

  if (isForm(expr) && (expr.calls("tuple") || expr.callsInternal("tuple"))) {
    return lowerTupleTypeExpr(expr, ctx, currentScope);
  }

  if (isForm(expr) && expr.calls("|")) {
    return lowerUnionTypeExpr(expr, ctx, currentScope);
  }

  if (
    isForm(expr) &&
    (expr.calls("->") || expr.calls(":") || expr.calls("fn"))
  ) {
    return lowerFunctionTypeExpr(expr, ctx, currentScope);
  }

  if (isForm(expr)) {
    const named = lowerNamedTypeForm(expr, ctx, currentScope);
    if (named) {
      return named;
    }
  }

  throw new Error(`unsupported type expression: ${JSON.stringify(expr)}`);
};

const lowerNamedType = (
  atom: Syntax & { value: string },
  ctx: LowerContext,
  scope: ScopeId
): HirTypeExpr => ({
  typeKind: "named",
  ast: atom.syntaxId,
  span: toSourceSpan(atom),
  path: [atom.value],
  symbol: resolveTypeSymbol(atom.value, scope, ctx),
});

const lowerNamedTypeForm = (
  form: Form,
  ctx: LowerContext,
  scope: ScopeId
): HirTypeExpr | undefined => {
  if (
    !isIdentifierAtom(form.first) ||
    !isForm(form.second) ||
    !formCallsInternal(form.second, "generics")
  ) {
    return undefined;
  }

  const name = form.first;
  const genericsForm = form.second;
  const typeArguments = genericsForm.rest
    .map((entry) => lowerTypeExpr(entry, ctx, scope))
    .filter(Boolean) as HirTypeExpr[];

  return {
    typeKind: "named",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    path: [name.value],
    symbol: resolveTypeSymbol(name.value, scope, ctx),
    typeArguments,
  };
};

const isObjectTypeForm = (form: Form): boolean =>
  form.callsInternal("object_literal");

const lowerObjectTypeExpr = (
  form: Form,
  ctx: LowerContext,
  scope: ScopeId
): HirTypeExpr => {
  const fields = form.rest.map((entry) =>
    lowerObjectTypeField(entry, ctx, scope)
  );
  return {
    typeKind: "object",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    fields,
  };
};

const lowerObjectTypeField = (
  entry: Expr | undefined,
  ctx: LowerContext,
  scope: ScopeId
): HirRecordTypeField => {
  if (!isForm(entry) || !entry.calls(":")) {
    throw new Error("object type fields must be labeled");
  }
  const nameExpr = entry.at(1);
  if (!isIdentifierAtom(nameExpr)) {
    throw new Error("object type field name must be an identifier");
  }
  const typeExpr = entry.at(2);
  if (!typeExpr) {
    throw new Error("object type field missing type expression");
  }
  const type = lowerTypeExpr(typeExpr, ctx, scope);
  if (!type) {
    throw new Error("object type field missing resolved type expression");
  }
  return {
    name: nameExpr.value,
    type,
    span: toSourceSpan(entry),
  };
};

const lowerTupleTypeExpr = (
  form: Form,
  ctx: LowerContext,
  scope: ScopeId
): HirTypeExpr => {
  const elements = form.rest.map((entry) => {
    const lowered = lowerTypeExpr(entry, ctx, scope);
    if (!lowered) {
      throw new Error("tuple type element missing resolved type expression");
    }
    return lowered;
  });
  return {
    typeKind: "tuple",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    elements,
  };
};

const lowerUnionTypeExpr = (
  form: Form,
  ctx: LowerContext,
  scope: ScopeId
): HirTypeExpr => {
  const members = form.rest.map((entry) => {
    const lowered = lowerTypeExpr(entry, ctx, scope);
    if (!lowered) {
      throw new Error("union type member missing resolved type expression");
    }
    return lowered;
  });
  return {
    typeKind: "union",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    members,
  };
};

const lowerFunctionTypeExpr = (
  form: Form,
  ctx: LowerContext,
  scope: ScopeId
): HirFunctionTypeExpr => {
  const signature = parseLambdaSignature(form);
  if (!signature.returnType) {
    throw new Error("function type missing return type");
  }

  const typeParameters = lowerTypeParameters(
    signature.typeParameters?.map((param) => {
      const symbol = resolveTypeSymbol(param.value, scope, ctx);
      if (!symbol) {
        throw new Error(`unknown type parameter ${param.value} in function type`);
      }
      return { symbol, ast: param };
    })
  );

  const parameters = signature.parameters.map((param) => {
    const paramTypeExpr = isForm(param) && param.calls(":") ? param.at(2) : param;
    const lowered = lowerTypeExpr(paramTypeExpr, ctx, scope);
    if (!lowered) {
      throw new Error("function type parameter missing type");
    }
    return lowered;
  });

  const returnType = lowerTypeExpr(signature.returnType, ctx, scope);
  if (!returnType) {
    throw new Error("function type missing resolved return type");
  }

  const effectType = lowerTypeExpr(signature.effectType, ctx, scope);

  return {
    typeKind: "function",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    typeParameters,
    parameters,
    returnType,
    effectType,
  };
};

export const lowerTypeParameters = (
  params: readonly { symbol: SymbolId; ast?: Syntax }[] | undefined
): HirTypeParameter[] | undefined => {
  if (!params || params.length === 0) {
    return undefined;
  }

  return params.map((param) => ({
    symbol: param.symbol,
    span: toSourceSpan(param.ast),
  }));
};
