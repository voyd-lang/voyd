import {
  type Expr,
  formCallsInternal,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../parser/index.js";

export const importedSymbolTargetFromMetadata = (
  source?: Record<string, unknown>,
): { moduleId: string; symbol: number } | undefined => {
  const meta = source as
    | { import?: { moduleId?: unknown; symbol?: unknown } | undefined }
    | undefined;
  const moduleId = meta?.import?.moduleId;
  const symbol = meta?.import?.symbol;
  return typeof moduleId === "string" && typeof symbol === "number"
    ? { moduleId, symbol }
    : undefined;
};

export const enumVariantTypeNamesFromAliasTarget = (
  target: Expr | undefined,
): string[] | undefined => {
  const collected = collectUnionNominalTypeNames(target);
  if (!collected || collected.length === 0) {
    return undefined;
  }
  return Array.from(new Set(collected));
};

const collectUnionNominalTypeNames = (
  expr: Expr | undefined,
): string[] | undefined => {
  if (!expr) {
    return undefined;
  }

  if (isForm(expr) && expr.calls("|") && expr.length === 3) {
    const left = collectUnionNominalTypeNames(expr.at(1));
    const right = collectUnionNominalTypeNames(expr.at(2));
    if (!left || !right) {
      return undefined;
    }
    return [...left, ...right];
  }

  const nominalName = extractNominalTypeName(expr);
  return nominalName ? [nominalName] : undefined;
};

const extractNominalTypeName = (expr: Expr | undefined): string | undefined => {
  if (!expr) {
    return undefined;
  }

  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    return expr.value;
  }

  if (!isForm(expr)) {
    return undefined;
  }

  if (formCallsInternal(expr, "generics")) {
    return extractNominalTypeName(expr.at(1));
  }

  if (expr.length === 2) {
    const head = expr.at(0);
    const second = expr.at(1);
    if (
      (isIdentifierAtom(head) || isInternalIdentifierAtom(head)) &&
      isForm(second) &&
      formCallsInternal(second, "generics")
    ) {
      return head.value;
    }
  }

  return undefined;
};
