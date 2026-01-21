import {
  type Expr,
  isForm,
  isIdentifierAtom,
} from "../parser/index.js";
import type { SourceSpan } from "../semantics/ids.js";

export type UsePathImportKind = "all" | "self" | "name";

export type NormalizedUseEntry = {
  moduleSegments: readonly string[];
  path: readonly string[];
  targetName?: string;
  alias?: string;
  importKind: UsePathImportKind;
  anchorToSelf?: boolean;
  span: SourceSpan;
};

type RawUseEntry = {
  segments: readonly string[];
  span: SourceSpan;
  alias?: string;
};

export const parseUsePaths = (
  expr: Expr | undefined,
  span: SourceSpan,
  base: readonly string[] = []
): NormalizedUseEntry[] => {
  if (!expr) {
    return [];
  }
  if (isIdentifierAtom(expr)) {
    return [normalizeUseEntry({ segments: [...base, expr.value], span })];
  }

  if (!isForm(expr)) {
    return [];
  }

  if (expr.calls("::")) {
    const leftExpr = expr.at(1);
    const rightExpr = expr.at(2);
    if (
      base.length === 0 &&
      isIdentifierAtom(leftExpr) &&
      leftExpr.value === "self"
    ) {
      return parseUsePaths(rightExpr, span, base).map((entry) => ({
        ...entry,
        anchorToSelf: true,
      }));
    }
    const left = parseUsePaths(leftExpr, span, base);
    return left.flatMap((entry) =>
      parseUsePaths(rightExpr, span, entry.path).map((next) => ({
        ...next,
        anchorToSelf: entry.anchorToSelf || next.anchorToSelf,
      }))
    );
  }

  if (expr.calls("as")) {
    const aliasExpr = expr.at(2);
    const alias = isIdentifierAtom(aliasExpr) ? aliasExpr.value : undefined;
    return parseUsePaths(expr.at(1), span, base).map((entry) => ({
      ...entry,
      alias: alias ?? entry.alias,
    }));
  }

  if (expr.callsInternal("object_literal")) {
    return expr.rest.flatMap((entry) => parseUsePaths(entry, span, base));
  }

  return [];
};

const normalizeUseEntry = ({
  segments,
  span,
  alias,
}: RawUseEntry): NormalizedUseEntry => {
  const last = segments.at(-1);
  if (last === "all") {
    const moduleSegments = segments.slice(0, -1);
    return {
      moduleSegments,
      path: moduleSegments,
      importKind: "all",
      alias,
      span,
    };
  }

  if (last === "self") {
    const moduleSegments = segments.slice(0, -1);
    const name = moduleSegments.at(-1) ?? "self";
    return {
      moduleSegments,
      path: moduleSegments,
      importKind: "self",
      alias: alias ?? name,
      span,
    };
  }

  if (segments.length === 1 && last) {
    return {
      moduleSegments: segments,
      path: segments,
      targetName: last,
      alias: alias ?? last,
      importKind: "self",
      span,
    };
  }

  const targetName = last;
  const moduleSegments = segments.slice(0, -1);
  const name = targetName ?? segments.at(-1) ?? "self";
  return {
    moduleSegments,
    path: targetName ? [...moduleSegments, targetName] : moduleSegments,
    targetName,
    alias: alias ?? name,
    importKind: "name",
    span,
  };
};
