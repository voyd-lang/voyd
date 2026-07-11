import { type Expr, isForm, isIdentifierAtom } from "../ast/index.js";
import type { SourceSpan } from "../../diagnostics/index.js";
import { ParserSyntaxError } from "../errors.js";

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
  state: ParseUsePathState = {},
): NormalizedUseEntry[] => {
  if (!expr) {
    throw new ParserSyntaxError("use path is missing an entry");
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
    throw new ParserSyntaxError("unsupported use path entry", expr.location);
  }

  if (expr.calls("::")) {
    const leftExpr = expr.at(1);
    const rightExpr = expr.at(2);
    if (!leftExpr || !rightExpr || expr.length !== 3) {
      throw new ParserSyntaxError(
        "module access requires a path on both sides of '::'",
        expr.location,
      );
    }
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
      }),
    );
  }

  if (expr.calls("as")) {
    const targetExpr = expr.at(1);
    const aliasExpr = expr.at(2);
    if (!targetExpr || !isIdentifierAtom(aliasExpr) || expr.length !== 3) {
      throw new ParserSyntaxError(
        "use alias requires a path and identifier alias",
        expr.location,
      );
    }
    return parseUsePaths(targetExpr, span, base, state).map((entry) => ({
      ...entry,
      alias: aliasExpr.value,
    }));
  }

  if (expr.callsInternal("object_literal")) {
    if (expr.rest.length === 0) {
      throw new ParserSyntaxError(
        "grouped use path requires at least one selection",
        expr.location,
      );
    }
    return expr.rest.flatMap((entry) =>
      parseUsePaths(entry, span, base, {
        ...state,
        selectionContext: "group",
      }),
    );
  }

  throw new ParserSyntaxError("unsupported use path form", expr.location);
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
