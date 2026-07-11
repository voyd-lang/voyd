import {
  type Expr,
  type IdentifierAtom,
  type InternalIdentifierAtom,
  type Syntax,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../ast/index.js";
import { ParserSyntaxError } from "../errors.js";
import { normalizeNestedFunctionTypeAnnotation } from "./function-type-annotations.js";

type PatternIdentifier = IdentifierAtom | InternalIdentifierAtom;

export type SurfacePattern =
  | {
      kind: "identifier";
      name: PatternIdentifier;
      syntax: Syntax;
      bindingKind?: "mutable-ref";
    }
  | { kind: "tuple"; elements: readonly SurfacePattern[]; syntax: Syntax }
  | {
      kind: "destructure";
      fields: readonly { name: IdentifierAtom; pattern: SurfacePattern }[];
      spread?: SurfacePattern;
      syntax: Syntax;
    }
  | { kind: "typed"; pattern: SurfacePattern; typeExpr: Expr; syntax: Syntax };

const patternCache = new WeakMap<Expr, SurfacePattern>();

export const parseSurfacePattern = (expr: Expr | undefined): SurfacePattern => {
  if (!expr) throw new ParserSyntaxError("missing pattern");
  const cached = patternCache.get(expr);
  if (cached) return cached;
  const parsed = parseSurfacePatternUncached(expr);
  patternCache.set(expr, parsed);
  return parsed;
};

const parseSurfacePatternUncached = (expr: Expr): SurfacePattern => {
  if (isForm(expr) && expr.calls("~")) {
    const target = expr.at(1);
    if (!target)
      throw new ParserSyntaxError(
        "mutable pattern missing target",
        expr.location,
      );
    const parsed = parseSurfacePattern(target);
    if (parsed.kind !== "identifier") {
      throw new ParserSyntaxError(
        "mutable reference patterns must bind identifiers",
        expr.location,
      );
    }
    return { ...parsed, syntax: expr, bindingKind: "mutable-ref" };
  }
  if (isIdentifierAtom(expr) || isInternalIdentifierAtom(expr)) {
    return { kind: "identifier", name: expr, syntax: expr };
  }
  if (!isForm(expr)) {
    throw new ParserSyntaxError("unsupported pattern form", expr.location);
  }
  if (expr.calls("tuple") || expr.callsInternal("tuple")) {
    return {
      kind: "tuple",
      elements: expr.rest.map(parseSurfacePattern),
      syntax: expr,
    };
  }
  if (expr.callsInternal("object_literal")) {
    let spread: SurfacePattern | undefined;
    const fields = expr.rest.flatMap((entry) => {
      if (isIdentifierAtom(entry)) {
        return [{ name: entry, pattern: parseSurfacePattern(entry) }];
      }
      if (!isForm(entry)) {
        throw new ParserSyntaxError(
          "unsupported destructure entry in pattern",
          entry.location,
        );
      }
      if (entry.calls("...")) {
        if (spread) {
          throw new ParserSyntaxError(
            "destructure pattern supports at most one spread",
            entry.location,
          );
        }
        spread = parseSurfacePattern(entry.at(1));
        return [];
      }
      if (!entry.calls(":")) {
        throw new ParserSyntaxError(
          "unsupported destructure entry in pattern",
          entry.location,
        );
      }
      const name = entry.at(1);
      if (!isIdentifierAtom(name)) {
        throw new ParserSyntaxError(
          "destructure field name must be an identifier",
          entry.location,
        );
      }
      return [{ name, pattern: parseSurfacePattern(entry.at(2)) }];
    });
    return { kind: "destructure", fields, spread, syntax: expr };
  }
  if (expr.calls(":")) {
    const { nameExpr, typeExpr } = normalizeNestedFunctionTypeAnnotation(expr);
    if (!typeExpr) {
      throw new ParserSyntaxError(
        "typed pattern is missing a type annotation",
        expr.location,
      );
    }
    return {
      kind: "typed",
      pattern: parseSurfacePattern(nameExpr),
      typeExpr,
      syntax: expr,
    };
  }
  throw new ParserSyntaxError("unsupported pattern form", expr.location);
};
