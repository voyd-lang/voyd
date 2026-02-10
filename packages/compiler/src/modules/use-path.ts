import {
  type Expr,
  isForm,
  isIdentifierAtom,
} from "../parser/index.js";
import type { SourceSpan } from "../semantics/ids.js";

export type UsePathSelectionKind = "all" | "module" | "name";

export type NormalizedUseEntry = {
  moduleSegments: readonly string[];
  path: readonly string[];
  targetName?: string;
  alias?: string;
  selectionKind: UsePathSelectionKind;
  anchorToSelf?: boolean;
  parentHops?: number;
  hasExplicitPrefix: boolean;
  span: SourceSpan;
};

type RawUseEntry = {
  segments: readonly string[];
  span: SourceSpan;
  alias?: string;
  anchorToSelf?: boolean;
  parentHops?: number;
  hasExplicitPrefix?: boolean;
  selectionContext?: "direct" | "group";
};

type ParseUsePathState = {
  anchorToSelf?: boolean;
  parentHops?: number;
  hasExplicitPrefix?: boolean;
  selectionContext?: "direct" | "group";
};

const ROOT_PREFIXES = new Set(["self", "super", "src", "std", "pkg"]);

export const parseUsePaths = (
  expr: Expr | undefined,
  span: SourceSpan,
  base: readonly string[] = [],
  state: ParseUsePathState = {}
): NormalizedUseEntry[] => {
  if (!expr) {
    return [];
  }
  if (isIdentifierAtom(expr)) {
    const isRootPrefix = base.length === 0 && ROOT_PREFIXES.has(expr.value);
    const nextState = isRootPrefix
      ? expr.value === "self"
        ? {
            ...state,
            anchorToSelf: true,
            hasExplicitPrefix: true,
          }
        : expr.value === "super"
        ? {
            ...state,
            parentHops: (state.parentHops ?? 0) + 1,
            hasExplicitPrefix: true,
          }
        : {
            ...state,
            hasExplicitPrefix: true,
          }
      : state;
    return [
      normalizeUseEntry({
        segments: [...base, expr.value],
        span,
        anchorToSelf: nextState.anchorToSelf,
        parentHops: nextState.parentHops,
        hasExplicitPrefix: nextState.hasExplicitPrefix,
        selectionContext: nextState.selectionContext,
      }),
    ];
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
      return parseUsePaths(rightExpr, span, base, {
        ...state,
        anchorToSelf: true,
        hasExplicitPrefix: true,
      });
    }
    if (
      base.length === 0 &&
      isIdentifierAtom(leftExpr) &&
      leftExpr.value === "super"
    ) {
      return parseUsePaths(rightExpr, span, base, {
        ...state,
        parentHops: (state.parentHops ?? 0) + 1,
        hasExplicitPrefix: true,
      });
    }
    const left = parseUsePaths(leftExpr, span, base, state);
    return left.flatMap((entry) =>
      parseUsePaths(rightExpr, span, entry.path, {
        anchorToSelf: entry.anchorToSelf,
        parentHops: entry.parentHops,
        hasExplicitPrefix: entry.hasExplicitPrefix,
        selectionContext: state.selectionContext,
      })
    );
  }

  if (expr.calls("as")) {
    const aliasExpr = expr.at(2);
    const alias = isIdentifierAtom(aliasExpr) ? aliasExpr.value : undefined;
    return parseUsePaths(expr.at(1), span, base, state).map((entry) => ({
      ...entry,
      alias: alias ?? entry.alias,
    }));
  }

  if (expr.callsInternal("object_literal")) {
    return expr.rest.flatMap((entry) =>
      parseUsePaths(entry, span, base, {
        ...state,
        selectionContext: "group",
      }),
    );
  }

  return [];
};

const normalizeUseEntry = ({
  segments,
  span,
  alias,
  anchorToSelf,
  parentHops,
  hasExplicitPrefix: explicitPrefix,
  selectionContext,
}: RawUseEntry): NormalizedUseEntry => {
  const normalizedSegments =
    segments[0] === "pkg" && segments[1] === "std"
      ? ["std", ...segments.slice(2)]
      : segments;
  const last = normalizedSegments.at(-1);
  const startsWithNamespace =
    normalizedSegments[0] === "src" ||
    normalizedSegments[0] === "std" ||
    normalizedSegments[0] === "pkg";
  const hasExplicitPrefix =
    explicitPrefix === true ||
    anchorToSelf === true ||
    (parentHops ?? 0) > 0 ||
    startsWithNamespace;
  if (last === "all") {
    const moduleSegments = normalizedSegments.slice(0, -1);
    return {
      moduleSegments,
      path: moduleSegments,
      selectionKind: "all",
      alias,
      anchorToSelf,
      parentHops,
      hasExplicitPrefix,
      span,
    };
  }

  if (last === "self") {
    const moduleSegments = normalizedSegments.slice(0, -1);
    const name = moduleSegments.at(-1) ?? "self";
    return {
      moduleSegments,
      path: moduleSegments,
      selectionKind: "module",
      alias: alias ?? name,
      anchorToSelf,
      parentHops,
      hasExplicitPrefix,
      span,
    };
  }

  if (normalizedSegments.length === 1 && last) {
    return {
      moduleSegments: normalizedSegments,
      path: normalizedSegments,
      targetName: last,
      alias: alias ?? last,
      selectionKind: "module",
      anchorToSelf,
      parentHops,
      hasExplicitPrefix,
      span,
    };
  }

  const first = normalizedSegments[0];
  if (
    normalizedSegments.length === 2 &&
    last &&
    (first === "src" ||
      first === "pkg" ||
      (first === "std" && selectionContext !== "group"))
  ) {
    return {
      moduleSegments: normalizedSegments,
      path: normalizedSegments,
      selectionKind: "module",
      alias: alias ?? last,
      anchorToSelf,
      parentHops,
      hasExplicitPrefix,
      span,
    };
  }

  const targetName = last;
  const moduleSegments = normalizedSegments.slice(0, -1);
  const name = targetName ?? normalizedSegments.at(-1) ?? "self";
  return {
    moduleSegments,
    path: targetName ? [...moduleSegments, targetName] : moduleSegments,
    targetName,
    alias: alias ?? name,
    selectionKind: "name",
    anchorToSelf,
    parentHops,
    hasExplicitPrefix,
    span,
  };
};
