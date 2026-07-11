import {
  type Expr,
  type Form,
  type Syntax,
  isForm,
  isIdentifierAtom,
} from "../../parser/index.js";
import { toSourceSpan } from "../../parser/surface/utils.js";
import type {
  HirRecordTypeField,
  HirTypeExpr,
  HirFunctionTypeExpr,
  HirTypeParameter,
} from "../hir/index.js";
import { resolveTypeSymbol } from "./resolution.js";
import { resolveNamedTypeTarget } from "./named-type-resolution.js";
import type { LowerContext } from "./types.js";
import type { ScopeId, SymbolId } from "../ids.js";
import {
  parseSurfaceFunctionType,
  parseRecordFields,
  type SurfaceRecordField,
} from "../../parser/surface/index.js";

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
  scope?: ScopeId,
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
  scope: ScopeId,
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
  scope: ScopeId,
): HirTypeExpr | undefined => {
  const target = resolveNamedTypeTarget({
    expr: form,
    scope,
    ctx,
    parseTypeArguments: (entries) =>
      entries
        .map((entry) => lowerTypeExpr(entry, ctx, scope))
        .filter(Boolean) as HirTypeExpr[],
    allowNamespacedSymbolKind: (kind) =>
      kind === "type" || kind === "trait" || kind === "effect",
  });
  if (!target) {
    return undefined;
  }

  return {
    typeKind: "named",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    path: target.path,
    symbol: target.symbol,
    typeArguments: target.typeArguments,
  };
};

const isObjectTypeForm = (form: Form): boolean =>
  form.callsInternal("object_literal");

const lowerObjectTypeExpr = (
  form: Form,
  ctx: LowerContext,
  scope: ScopeId,
): HirTypeExpr => {
  const fields = parseRecordFields(form).map((entry) =>
    lowerObjectTypeField(entry, ctx, scope),
  );
  return {
    typeKind: "object",
    ast: form.syntaxId,
    span: toSourceSpan(form),
    fields,
  };
};

const lowerObjectTypeField = (
  entry: SurfaceRecordField,
  ctx: LowerContext,
  scope: ScopeId,
): HirRecordTypeField => {
  const type = lowerTypeExpr(entry.value, ctx, scope);
  if (!type) {
    throw new Error("object type field missing resolved type expression");
  }
  const optional = entry.optional;
  return {
    name: entry.name.value,
    type: optional ? wrapInOptionalTypeExpr({ inner: type, ctx, scope }) : type,
    ...(optional ? { optional: true } : {}),
    span: toSourceSpan(entry.form),
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
  scope: ScopeId,
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
  scope: ScopeId,
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
  scope: ScopeId,
): HirFunctionTypeExpr => {
  const functionType = parseSurfaceFunctionType(form);
  const { signature } = functionType;

  const typeParameters = lowerTypeParameters({
    params: signature.typeParameters?.map((param) => {
      const symbol = resolveTypeSymbol(param.value, scope, ctx);
      if (!symbol) {
        throw new Error(
          `unknown type parameter ${param.value} in function type`,
        );
      }
      return { symbol, ast: param };
    }),
    ctx,
    scope,
  });

  const parameters = functionType.parameters.map((param) => {
    const lowered = lowerTypeExpr(param.typeExpr, ctx, scope);
    if (!lowered) {
      throw new Error("function type parameter missing type");
    }
    const type = param.optional
      ? wrapInOptionalTypeExpr({ inner: lowered, ctx, scope })
      : lowered;
    return { type, optional: param.optional ? true : undefined };
  });

  const returnType = lowerTypeExpr(functionType.returnType, ctx, scope);
  if (!returnType) {
    throw new Error("function type missing resolved return type");
  }

  const effectType = lowerTypeExpr(functionType.effectType, ctx, scope);

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

export const lowerTypeParameters = ({
  params,
  ctx,
  scope,
}: {
  params:
    | readonly { symbol: SymbolId; ast?: Syntax; constraint?: Expr }[]
    | undefined;
  ctx: LowerContext;
  scope: ScopeId;
}): HirTypeParameter[] | undefined => {
  if (!params || params.length === 0) {
    return undefined;
  }

  return params.map((param) => ({
    symbol: param.symbol,
    span: toSourceSpan(param.ast),
    constraint: lowerTypeExpr(param.constraint, ctx, scope),
  }));
};
