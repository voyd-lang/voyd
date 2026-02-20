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
import type { HirExprId, ScopeId, SymbolId } from "../../ids.js";
import type { HirTypeExpr } from "../../hir/index.js";
import {
  lowerResolvedCallee,
  resolveModuleMemberCallResolution,
  resolveModuleMemberResolution,
  resolveStaticMethodResolution,
} from "./resolution-helpers.js";
import { lowerNominalObjectLiteral } from "./call.js";
import type { LoweringFormParams, LoweringParams } from "./types.js";
import { resolveConstructorResolution, resolveTypeSymbol } from "../resolution.js";
import { lowerTypeExpr } from "../type-expressions.js";
import { resolveModulePathSymbol } from "./namespace-resolution.js";
import { lowerQualifiedTraitMethodCall } from "./qualified-trait-call.js";
import { lowerEnumNamespaceMemberTypeArgumentsFromMetadata } from "../../enum-namespace.js";
import { substituteTypeParametersInTypeExpr } from "../../hir/type-expr-substitution.js";

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

  const targetTypeArguments = extractStaticTargetTypeArguments({
    targetExpr,
    ctx,
    scopes,
    lowerExpr,
  });
  const targetSymbol = resolveStaticTargetSymbol(
    targetExpr,
    scopes.current(),
    ctx
  );
  if (typeof targetSymbol === "number") {
    const targetRecord = ctx.symbolTable.getSymbol(targetSymbol);
    if (targetRecord.kind === "trait") {
      if (!isForm(memberExpr)) {
        throw new Error("qualified trait access must be a call expression");
      }
      return lowerQualifiedTraitCall({
        accessForm: form,
        traitSymbol: targetSymbol,
        memberForm: memberExpr,
        ctx,
        scopes,
        lowerExpr,
      });
    }

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
      const constructorResolution =
        resolution.kind === "symbol" &&
        ctx.symbolTable.getSymbol(resolution.symbol).kind === "type"
          ? resolveConstructorResolution({
              targetSymbol: resolution.symbol,
              name: memberExpr.value,
              ctx,
            })
          : undefined;
      return lowerResolvedCallee({
        resolution: constructorResolution ?? resolution,
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
    targetTypeArguments,
    ctx,
    scopes,
    lowerExpr,
  });
  if (typeof moduleAccess === "number") {
    return moduleAccess;
  }

  throw new Error("static access target must be a type or module");
};

const lowerQualifiedTraitCall = ({
  accessForm,
  traitSymbol,
  memberForm,
  ctx,
  scopes,
  lowerExpr,
}: {
  accessForm: Form;
  traitSymbol: SymbolId;
  memberForm: Form;
} & LoweringParams): HirExprId => {
  return lowerQualifiedTraitMethodCall({
    accessForm,
    traitSymbol,
    memberForm,
    receiverSource: { kind: "first-arg" },
    ctx,
    scopes,
    lowerExpr,
  });
};

const lowerModuleAccess = ({
  accessForm,
  targetExpr,
  memberExpr,
  targetTypeArguments,
  ctx,
  scopes,
  lowerExpr,
}: {
  accessForm: Form;
  targetExpr: Expr;
  memberExpr: Expr;
  targetTypeArguments?: HirTypeExpr[];
} & LoweringParams): HirExprId | undefined => {
  const moduleSymbol = resolveModulePathSymbol(
    targetExpr,
    scopes.current(),
    ctx
  );
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
      targetTypeArguments,
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
  const enumNamespaceTypeArguments = lowerEnumNamespaceMemberTypeArguments({
    namespaceSymbol: targetSymbol,
    memberName: calleeExpr.value,
    namespaceTypeArguments: targetTypeArguments,
    scope: scopes.current(),
    ctx,
  });
  const combinedTypeArguments = [
    ...(typeArguments ?? []),
    ...(enumNamespaceTypeArguments.typeArguments ?? []),
    ...(enumNamespaceTypeArguments.consumeNamespaceTypeArguments
      ? []
      : (targetTypeArguments ?? [])),
  ];

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
  const namespaceMemberSymbols =
    methodTable.get(calleeExpr.value) ?? new Set<SymbolId>();

  const nominal = lowerNominalObjectLiteral({
    callee: calleeExpr,
    args: memberForm.rest,
    ast: accessForm,
    fallbackTypeArguments: combinedTypeArguments,
    allowedTargetSymbols: namespaceMemberSymbols,
    ctx,
    scopes,
    lowerExpr,
  });
  if (typeof nominal === "number") {
    return nominal;
  }

  const resolution = resolveStaticMethodResolution({
    name: calleeExpr.value,
    targetSymbol,
    methodTable,
    ctx,
  });
  const constructorResolution =
    resolution.kind === "symbol" &&
    ctx.symbolTable.getSymbol(resolution.symbol).kind === "type"
      ? resolveConstructorResolution({
          targetSymbol: resolution.symbol,
          name: calleeExpr.value,
          ctx,
        })
      : undefined;
  const callee = lowerResolvedCallee({
    resolution: constructorResolution ?? resolution,
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
      combinedTypeArguments.length > 0
        ? combinedTypeArguments
        : undefined,
  });
};

const lowerEnumNamespaceMemberTypeArguments = ({
  namespaceSymbol,
  memberName,
  namespaceTypeArguments,
  scope,
  ctx,
}: {
  namespaceSymbol: SymbolId;
  memberName: string;
  namespaceTypeArguments?: readonly HirTypeExpr[];
  scope: ScopeId;
  ctx: LoweringParams["ctx"];
}): {
  typeArguments?: HirTypeExpr[];
  consumeNamespaceTypeArguments: boolean;
} => {
  const namespaceRecord = ctx.symbolTable.getSymbol(namespaceSymbol);
  return lowerEnumNamespaceMemberTypeArgumentsFromMetadata({
    source: namespaceRecord.metadata as Record<string, unknown> | undefined,
    memberName,
    namespaceTypeArguments,
    lowerTypeArgument: (entry) => lowerTypeExpr(entry, ctx, scope),
    substituteTypeArgument: ({ typeArgument, substitutionsByName }) =>
      substituteTypeParametersInTypeExpr({
        typeExpr: typeArgument,
        substitutionsByName,
      }),
  });
};

const lowerModuleQualifiedCall = ({
  accessForm,
  memberForm,
  memberTable,
  moduleSymbol,
  targetTypeArguments,
  ctx,
  scopes,
  lowerExpr,
}: {
  accessForm: Form;
  memberForm: Form;
  memberTable: ReadonlyMap<string, Set<SymbolId>>;
  moduleSymbol: SymbolId;
  targetTypeArguments?: HirTypeExpr[];
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
  const combinedTypeArguments =
    targetTypeArguments &&
    targetTypeArguments.length > 0 &&
    ctx.symbolTable.getSymbol(moduleSymbol).kind === "effect"
      ? [...(typeArguments ?? []), ...targetTypeArguments]
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
    typeArguments:
      combinedTypeArguments && combinedTypeArguments.length > 0
        ? combinedTypeArguments
        : undefined,
  });
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
  const genericArgs = extractTypeArgumentForms(
    extractNamespaceTailExpr(targetExpr),
  );
  if (!genericArgs || genericArgs.length === 0) {
    return undefined;
  }
  const typeArguments = genericArgs
    .map((entry) => lowerTypeExpr(entry, ctx, scopes.current()))
    .filter(Boolean) as HirTypeExpr[];
  return typeArguments.length > 0 ? typeArguments : undefined;
};

const extractNamespaceTailExpr = (expr: Expr): Expr => {
  if (!isForm(expr) || !expr.calls("::") || expr.length !== 3) {
    return expr;
  }

  const member = expr.at(2);
  return member ? extractNamespaceTailExpr(member) : expr;
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
