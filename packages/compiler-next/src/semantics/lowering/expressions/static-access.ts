import {
  type Expr,
  type Form,
  type Syntax,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../../../parser/index.js";
import { extractConstructorTargetIdentifier } from "../../constructors.js";
import { toSourceSpan } from "../../utils.js";
import type { HirExprId, ScopeId, SymbolId } from "../ids.js";
import type { HirTypeExpr } from "../hir/index.js";
import {
  lowerResolvedCallee,
  resolveModuleMemberCallResolution,
  resolveModuleMemberResolution,
  resolveStaticMethodResolution,
} from "./resolution-helpers.js";
import { lowerNominalObjectLiteral } from "./call.js";
import type { LoweringFormParams, LoweringParams } from "./types.js";
import { resolveSymbol, resolveTypeSymbol } from "../resolution.js";
import { lowerTypeExpr } from "../type-expressions.js";

export const lowerStaticAccessExpr = ({
  form,
  ctx,
  scopes,
  lowerExpr,
}: LoweringFormParams): HirExprId => {
  const targetExpr = form.at(1);
  const memberExpr = form.at(2);
  if (!targetExpr || !memberExpr) {
    throw new Error("static access expression missing target or member");
  }

  const targetSymbol = resolveStaticTargetSymbol(
    targetExpr,
    scopes.current(),
    ctx
  );
  if (typeof targetSymbol === "number") {
    const targetTypeArguments = extractStaticTargetTypeArguments({
      targetExpr,
      ctx,
      scopes,
    });
    const methodTable = ctx.staticMethods.get(targetSymbol);
    if (!methodTable) {
      const targetName = ctx.symbolTable.getSymbol(targetSymbol).name;
      throw new Error(`type ${targetName} does not declare static methods`);
    }

    if (isForm(memberExpr)) {
      return lowerStaticMethodCall({
        accessForm: form,
        memberForm: memberExpr,
        methodTable,
        targetSymbol,
        targetTypeArguments,
        ctx,
        scopes,
        lowerExpr,
      });
    }

    if (isIdentifierAtom(memberExpr) || isInternalIdentifierAtom(memberExpr)) {
      const resolution = resolveStaticMethodResolution({
        name: memberExpr.value,
        targetSymbol,
        methodTable,
        ctx,
      });
      return lowerResolvedCallee({
        resolution,
        syntax: memberExpr,
        ctx,
      });
    }
    throw new Error("unsupported static access expression");
  }

  const moduleAccess = lowerModuleAccess({
    accessForm: form,
    targetExpr,
    memberExpr,
    ctx,
    scopes,
    lowerExpr,
  });
  if (typeof moduleAccess === "number") {
    return moduleAccess;
  }

  throw new Error("static access target must be a type or module");
};

const lowerModuleAccess = ({
  accessForm,
  targetExpr,
  memberExpr,
  ctx,
  scopes,
  lowerExpr,
}: {
  accessForm: Form;
  targetExpr: Expr;
  memberExpr: Expr;
} & LoweringParams): HirExprId | undefined => {
  const moduleSymbol = resolveModuleSymbol(targetExpr, scopes.current(), ctx);
  if (typeof moduleSymbol !== "number") {
    return undefined;
  }
  const memberName = extractModuleMemberName(memberExpr);
  if (!memberName) {
    return undefined;
  }
  const memberTable = ctx.moduleMembers.get(moduleSymbol);
  if (!memberTable) {
    const targetName = ctx.symbolTable.getSymbol(moduleSymbol).name;
    throw new Error(`module ${targetName} does not expose members`);
  }

  if (isForm(memberExpr)) {
    return lowerModuleQualifiedCall({
      accessForm,
      memberForm: memberExpr,
      memberTable,
      moduleSymbol,
      ctx,
      scopes,
      lowerExpr,
    });
  }

  const resolution = resolveModuleMemberResolution({
    name: memberName,
    moduleSymbol,
    memberTable,
    ctx,
  });
  if (!resolution) {
    return undefined;
  }
  return lowerResolvedCallee({
    resolution,
    syntax: memberExpr as Syntax,
    ctx,
  });
};

const extractModuleMemberName = (expr: Expr | undefined): string | undefined => {
  if (!expr) return undefined;
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    return expr.value;
  }
  if (!isForm(expr)) {
    return undefined;
  }
  const head = expr.at(0);
  if (isIdentifierAtom(head) || isInternalIdentifierAtom(head)) {
    return head.value;
  }
  return undefined;
};

const lowerStaticMethodCall = ({
  accessForm,
  memberForm,
  methodTable,
  targetSymbol,
  targetTypeArguments,
  ctx,
  scopes,
  lowerExpr,
}: {
  accessForm: Form;
  memberForm: Form;
  methodTable: ReadonlyMap<string, Set<SymbolId>>;
  targetSymbol: SymbolId;
  targetTypeArguments?: HirTypeExpr[];
} & LoweringParams): HirExprId => {
  const elements = memberForm.toArray();
  if (elements.length === 0) {
    throw new Error("static method call missing callee");
  }

  const calleeExpr = elements[0]!;
  if (
    !isIdentifierAtom(calleeExpr) &&
    !isInternalIdentifierAtom(calleeExpr)
  ) {
    throw new Error("static method name must be an identifier");
  }

  const potentialGenerics = elements[1];
  const hasTypeArguments =
    isForm(potentialGenerics) &&
    formCallsInternal(potentialGenerics, "generics");
  const typeArguments = hasTypeArguments
    ? ((potentialGenerics as Form).rest
        .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
        .filter(Boolean) as NonNullable<ReturnType<typeof lowerTypeExpr>>[])
    : undefined;
  const combinedTypeArguments =
    targetTypeArguments && targetTypeArguments.length > 0
      ? [
          ...(typeArguments ?? []),
          ...(targetTypeArguments.filter(Boolean) as HirTypeExpr[]),
        ]
      : typeArguments;

  const args = elements.slice(hasTypeArguments ? 2 : 1).map((arg) => {
    if (isForm(arg) && arg.calls(":")) {
      const labelExpr = arg.at(1);
      const valueExpr = arg.at(2);
      if (!isIdentifierAtom(labelExpr) || !valueExpr) {
        throw new Error("Invalid labeled argument");
      }
      return {
        label: labelExpr.value,
        expr: lowerExpr(valueExpr, ctx, scopes),
      };
    }
    const expr = lowerExpr(arg, ctx, scopes);
    return { expr };
  });

  const resolution = resolveStaticMethodResolution({
    name: calleeExpr.value,
    targetSymbol,
    methodTable,
    ctx,
  });
  const callee = lowerResolvedCallee({
    resolution,
    syntax: calleeExpr,
    ctx,
  });

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "call",
    ast: accessForm.syntaxId,
    span: toSourceSpan(accessForm),
    callee,
    args,
    typeArguments:
      combinedTypeArguments && combinedTypeArguments.length > 0
        ? combinedTypeArguments
        : undefined,
  });
};

const lowerModuleQualifiedCall = ({
  accessForm,
  memberForm,
  memberTable,
  moduleSymbol,
  ctx,
  scopes,
  lowerExpr,
}: {
  accessForm: Form;
  memberForm: Form;
  memberTable: ReadonlyMap<string, Set<SymbolId>>;
  moduleSymbol: SymbolId;
} & LoweringParams): HirExprId => {
  const elements = memberForm.toArray();
  if (elements.length === 0) {
    throw new Error("module-qualified call missing callee");
  }

  const calleeExpr = elements[0]!;
  if (
    !isIdentifierAtom(calleeExpr) &&
    !isInternalIdentifierAtom(calleeExpr)
  ) {
    throw new Error("module-qualified callee must be an identifier");
  }

  const potentialGenerics = elements[1];
  const hasTypeArguments =
    isForm(potentialGenerics) &&
    formCallsInternal(potentialGenerics, "generics");
  const typeArguments = hasTypeArguments
    ? ((potentialGenerics as Form).rest
        .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
        .filter(Boolean) as NonNullable<ReturnType<typeof lowerTypeExpr>>[])
    : undefined;

  const args = elements.slice(hasTypeArguments ? 2 : 1).map((arg) => {
    if (isForm(arg) && arg.calls(":")) {
      const labelExpr = arg.at(1);
      const valueExpr = arg.at(2);
      if (!isIdentifierAtom(labelExpr) || !valueExpr) {
        throw new Error("Invalid labeled argument");
      }
      return {
        label: labelExpr.value,
        expr: lowerExpr(valueExpr, ctx, scopes),
      };
    }
    const expr = lowerExpr(arg, ctx, scopes);
    return { expr };
  });

  const nominal = lowerNominalObjectLiteral({
    callee: calleeExpr,
    args: memberForm.rest,
    ast: accessForm,
    ctx,
    scopes,
    lowerExpr,
  });
  if (typeof nominal === "number") {
    return nominal;
  }

  const resolution = resolveModuleMemberCallResolution({
    name: calleeExpr.value,
    moduleSymbol,
    memberTable,
    ctx,
  });
  if (!resolution) {
    const moduleName = ctx.symbolTable.getSymbol(moduleSymbol).name;
    throw new Error(
      `module ${moduleName} does not export ${calleeExpr.value}`
    );
  }

  const callee = lowerResolvedCallee({
    resolution,
    syntax: calleeExpr,
    ctx,
  });

  return ctx.builder.addExpression({
    kind: "expr",
    exprKind: "call",
    ast: accessForm.syntaxId,
    span: toSourceSpan(accessForm),
    callee,
    args,
    typeArguments,
  });
};

const resolveModuleSymbol = (
  expr: Expr,
  scope: ScopeId,
  ctx: LoweringParams["ctx"]
): SymbolId | undefined => {
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    const symbol = resolveSymbol(expr.value, scope, ctx);
    if (typeof symbol === "number") {
      const record = ctx.symbolTable.getSymbol(symbol);
      if (record.kind === "module") {
        return symbol;
      }
    }
  }
  return undefined;
};

const resolveStaticTargetSymbol = (
  expr: Expr,
  scope: ScopeId,
  ctx: LoweringParams["ctx"]
): SymbolId | undefined => {
  const identifier = extractConstructorTargetIdentifier(expr);
  if (!identifier) {
    return undefined;
  }
  return resolveTypeSymbol(identifier.value, scope, ctx);
};

const extractStaticTargetTypeArguments = ({
  targetExpr,
  ctx,
  scopes,
}: {
  targetExpr: Expr;
} & LoweringParams): HirTypeExpr[] | undefined => {
  const genericArgs = extractTypeArgumentForms(targetExpr);
  if (!genericArgs || genericArgs.length === 0) {
    return undefined;
  }
  const typeArguments = genericArgs
    .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
    .filter(Boolean) as HirTypeExpr[];
  return typeArguments.length > 0 ? typeArguments : undefined;
};

const extractTypeArgumentForms = (
  expr: Expr
): readonly Expr[] | undefined => {
  if (isForm(expr) && isIdentifierAtom(expr.first)) {
    if (
      isForm(expr.second) &&
      formCallsInternal(expr.second, "generics")
    ) {
      return expr.second.rest;
    }
    return undefined;
  }

  if (isForm(expr) && formCallsInternal(expr, "generics")) {
    return expr.rest;
  }

  return undefined;
};
