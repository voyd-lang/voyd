import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../../../parser/index.js";
import type { ScopeId, SymbolId } from "../../ids.js";
import type { LowerContext } from "../types.js";
import { resolveSymbol } from "../resolution.js";
import { resolveModuleMemberResolution } from "./resolution-helpers.js";

const isNamespaceAccess = (expr: Expr | undefined): expr is Form =>
  isForm(expr) && expr.calls("::") && expr.length === 3;

const extractNamespaceMemberName = (expr: Expr | undefined): string | undefined => {
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

export const extractNamespaceSegments = (
  expr: Expr | undefined
): string[] | undefined => {
  if (!expr) return undefined;
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    return [expr.value];
  }
  if (!isNamespaceAccess(expr)) {
    return undefined;
  }
  const left = extractNamespaceSegments(expr.at(1));
  const right = extractNamespaceMemberName(expr.at(2));
  if (!left || !right) {
    return undefined;
  }
  return [...left, right];
};

export const resolveModulePathSymbol = (
  expr: Expr,
  scope: ScopeId,
  ctx: LowerContext
): SymbolId | undefined => {
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    const symbol = resolveSymbol(expr.value, scope, ctx);
    if (typeof symbol !== "number") {
      return undefined;
    }
    const record = ctx.symbolTable.getSymbol(symbol);
    return record.kind === "module" || record.kind === "effect"
      ? symbol
      : undefined;
  }

  if (!isNamespaceAccess(expr)) {
    return undefined;
  }

  const left = expr.at(1);
  const right = expr.at(2);
  if (!left || !right) {
    return undefined;
  }

  const moduleSymbol = resolveModulePathSymbol(left, scope, ctx);
  if (typeof moduleSymbol !== "number") {
    return undefined;
  }

  const memberName = extractNamespaceMemberName(right);
  if (!memberName) {
    return undefined;
  }

  const memberTable = ctx.moduleMembers.get(moduleSymbol);
  if (!memberTable) {
    return undefined;
  }

  const resolution = resolveModuleMemberResolution({
    name: memberName,
    moduleSymbol,
    memberTable,
    ctx,
  });
  if (!resolution || resolution.kind !== "symbol") {
    return undefined;
  }

  const record = ctx.symbolTable.getSymbol(resolution.symbol);
  return record.kind === "module" || record.kind === "effect"
    ? resolution.symbol
    : undefined;
};

