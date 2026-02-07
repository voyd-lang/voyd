import {
  type Expr,
  type Form,
  type IdentifierAtom,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
} from "../../parser/index.js";
import type { HirTypeExpr } from "../hir/index.js";
import type { ScopeId, SymbolId } from "../ids.js";
import { resolveModuleMemberResolution } from "./expressions/resolution-helpers.js";
import {
  extractNamespaceSegments,
  resolveModulePathSymbol,
} from "./expressions/namespace-resolution.js";
import { resolveTypeSymbol } from "./resolution.js";
import type { LowerContext } from "./types.js";

export interface ResolvedNamedTypeTarget {
  symbol?: SymbolId;
  path: string[];
  name: IdentifierAtom;
  typeArguments?: HirTypeExpr[];
}

export const resolveNamedTypeTarget = ({
  expr,
  scope,
  ctx,
  parseTypeArguments,
  allowUnqualifiedSymbolKind = () => true,
  allowNamespacedSymbolKind = (kind) => kind === "type" || kind === "trait",
  requireResolvedLocalSymbol = false,
}: {
  expr: Expr;
  scope: ScopeId;
  ctx: LowerContext;
  parseTypeArguments: (entries: readonly Expr[]) => HirTypeExpr[];
  allowUnqualifiedSymbolKind?: (kind: string) => boolean;
  allowNamespacedSymbolKind?: (kind: string) => boolean;
  requireResolvedLocalSymbol?: boolean;
}): ResolvedNamedTypeTarget | undefined => {
  const local = parseNamedTypeTarget({ expr, parseTypeArguments });
  if (local) {
    const symbol = resolveTypeSymbol(local.name.value, scope, ctx);
    if (requireResolvedLocalSymbol && typeof symbol !== "number") {
      return undefined;
    }
    if (typeof symbol === "number") {
      const symbolKind = ctx.symbolTable.getSymbol(symbol).kind;
      if (!allowUnqualifiedSymbolKind(symbolKind)) {
        return undefined;
      }
    }
    return {
      symbol,
      path: [local.name.value],
      name: local.name,
      typeArguments: local.typeArguments,
    };
  }

  if (!isForm(expr) || !expr.calls("::") || expr.length !== 3) {
    return undefined;
  }

  const moduleExpr = expr.at(1);
  const memberExpr = expr.at(2);
  if (!moduleExpr || !memberExpr) {
    return undefined;
  }

  const moduleSymbol = resolveModulePathSymbol(moduleExpr, scope, ctx);
  if (typeof moduleSymbol !== "number") {
    return undefined;
  }

  const member = parseNamedTypeTarget({ expr: memberExpr, parseTypeArguments });
  if (!member) {
    return undefined;
  }

  const memberTable = ctx.moduleMembers.get(moduleSymbol);
  if (!memberTable) {
    return undefined;
  }

  const resolution = resolveModuleMemberResolution({
    name: member.name.value,
    moduleSymbol,
    memberTable,
    ctx,
  });
  if (!resolution || resolution.kind !== "symbol") {
    return undefined;
  }

  const symbolKind = ctx.symbolTable.getSymbol(resolution.symbol).kind;
  if (!allowNamespacedSymbolKind(symbolKind)) {
    return undefined;
  }

  const moduleSegments =
    extractNamespaceSegments(moduleExpr) ??
    [ctx.symbolTable.getSymbol(moduleSymbol).name];

  return {
    symbol: resolution.symbol,
    path: [...moduleSegments, member.name.value],
    name: member.name,
    typeArguments: member.typeArguments,
  };
};

const isGenericsForm = (expr: Expr | undefined): expr is Form =>
  isForm(expr) && formCallsInternal(expr, "generics");

const parseNamedTypeTarget = ({
  expr,
  parseTypeArguments,
}: {
  expr: Expr;
  parseTypeArguments: (entries: readonly Expr[]) => HirTypeExpr[];
}): { name: IdentifierAtom; typeArguments?: HirTypeExpr[] } | undefined => {
  if (isIdentifierAtom(expr)) {
    return { name: expr };
  }

  if (!isForm(expr)) {
    return undefined;
  }

  const name = expr.at(0);
  const generics = expr.at(1);
  if (!isIdentifierAtom(name) || !isGenericsForm(generics) || expr.length !== 2) {
    return undefined;
  }

  return {
    name,
    typeArguments: parseTypeArguments(generics.rest),
  };
};
