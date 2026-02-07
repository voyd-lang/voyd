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
import { resolveModuleMemberResolution } from "./expressions/resolution-helpers.js";
import {
  extractNamespaceSegments,
  resolveModulePathSymbol,
} from "./expressions/namespace-resolution.js";
import type { LowerContext } from "./types.js";
import type { ScopeId, SymbolId } from "../ids.js";
import { parseLambdaSignature } from "../lambda.js";

export const wrapInOptionalTypeExpr = ({
  inner,
  ctx,
  scope,
}: {
  inner: HirTypeExpr;
  ctx: LowerContext;
  scope: ScopeId;
}): HirTypeExpr => ({
  typeKind: "named",
  ast: inner.ast,
  span: inner.span,
  path: ["Optional"],
  symbol: resolveTypeSymbol("Optional", scope, ctx),
  typeArguments: [inner],
});

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

  if (isForm(expr) && expr.calls("&")) {
    return lowerIntersectionTypeExpr(expr, ctx, currentScope);
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
  const local = lowerLocalNamedTypeForm(form, ctx, scope);
  if (local) {
    return local;
  }

  if (!form.calls("::") || form.length !== 3) {
    return undefined;
  }

  return lowerNamespacedNamedTypeForm(form, ctx, scope);
};

const lowerLocalNamedTypeForm = (
  form: Form,
  ctx: LowerContext,
  scope: ScopeId
): HirTypeExpr | undefined => {
  const target = extractNamedTypeTarget(form, ctx, scope);
  if (!target) {
    return undefined;
  }

  return {
    typeKind: "named",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    path: [target.name],
    symbol: resolveTypeSymbol(target.name, scope, ctx),
    typeArguments: target.typeArguments,
  };
};

const lowerNamespacedNamedTypeForm = (
  form: Form,
  ctx: LowerContext,
  scope: ScopeId
): HirTypeExpr | undefined => {
  const moduleExpr = form.at(1);
  const memberExpr = form.at(2);
  if (!moduleExpr || !memberExpr) {
    return undefined;
  }

  const moduleSymbol = resolveModulePathSymbol(moduleExpr, scope, ctx);
  if (typeof moduleSymbol !== "number") {
    return undefined;
  }

  const member = extractNamedTypeTarget(memberExpr, ctx, scope);
  if (!member) {
    return undefined;
  }

  const memberTable = ctx.moduleMembers.get(moduleSymbol);
  if (!memberTable) {
    return undefined;
  }

  const resolution = resolveModuleMemberResolution({
    name: member.name,
    moduleSymbol,
    memberTable,
    ctx,
  });
  if (!resolution || resolution.kind !== "symbol") {
    return undefined;
  }

  const symbolRecord = ctx.symbolTable.getSymbol(resolution.symbol);
  if (symbolRecord.kind !== "type" && symbolRecord.kind !== "trait") {
    return undefined;
  }

  const moduleSegments =
    extractNamespaceSegments(moduleExpr) ??
    [ctx.symbolTable.getSymbol(moduleSymbol).name];

  return {
    typeKind: "named",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    path: [...moduleSegments, member.name],
    symbol: resolution.symbol,
    typeArguments: member.typeArguments,
  };
};

const isGenericsForm = (expr: Expr | undefined): expr is Form =>
  isForm(expr) && formCallsInternal(expr, "generics");

const extractNamedTypeTarget = (
  expr: Expr,
  ctx: LowerContext,
  scope: ScopeId
): { name: string; typeArguments?: HirTypeExpr[] } | undefined => {
  if (isIdentifierAtom(expr)) {
    return { name: expr.value };
  }

  if (!isForm(expr)) {
    return undefined;
  }

  const name = expr.at(0);
  const generics = expr.at(1);
  if (!isIdentifierAtom(name) || !isGenericsForm(generics) || expr.length !== 2) {
    return undefined;
  }

  const typeArguments = generics.rest
    .map((entry) => lowerTypeExpr(entry, ctx, scope))
    .filter(Boolean) as HirTypeExpr[];
  return {
    name: name.value,
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

const lowerIntersectionTypeExpr = (
  form: Form,
  ctx: LowerContext,
  scope: ScopeId,
): HirTypeExpr => {
  const members = form.rest
    .map((entry) => lowerTypeExpr(entry, ctx, scope))
    .filter(Boolean) as HirTypeExpr[];
  return {
    typeKind: "intersection",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    members,
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
    const isOptional = isForm(param) && param.calls("?:");
    const paramTypeExpr =
      isForm(param) && (param.calls(":") || isOptional) ? param.at(2) : param;
    const lowered = lowerTypeExpr(paramTypeExpr, ctx, scope);
    if (!lowered) {
      throw new Error("function type parameter missing type");
    }
    const type = isOptional
      ? wrapInOptionalTypeExpr({ inner: lowered, ctx, scope })
      : lowered;
    return { type, optional: isOptional ? true : undefined };
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
