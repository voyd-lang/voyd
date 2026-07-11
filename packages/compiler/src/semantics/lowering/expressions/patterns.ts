import { type Expr } from "../../../parser/index.js";
import { toSourceSpan } from "../../../parser/surface/utils.js";
import type { HirPattern } from "../../hir/index.js";
import type { LowerContext, LowerScopeStack } from "../types.js";
import { resolveSymbol } from "../resolution.js";
import { lowerTypeExpr } from "../type-expressions.js";
import {
  parseSurfacePattern,
  type SurfacePattern,
} from "../../../parser/surface/index.js";

export const lowerPattern = (
  pattern: Expr | undefined,
  ctx: LowerContext,
  scopes: LowerScopeStack,
): HirPattern => {
  return lowerSurfacePattern(parseSurfacePattern(pattern), ctx, scopes);
};

export const lowerSurfacePattern = (
  pattern: SurfacePattern,
  ctx: LowerContext,
  scopes: LowerScopeStack,
): HirPattern => {
  if (pattern.kind === "identifier") {
    if (pattern.name.value === "_") {
      return { kind: "wildcard", span: toSourceSpan(pattern.syntax) };
    }
    const symbol = resolveSymbol(pattern.name.value, scopes.current(), ctx);
    return {
      kind: "identifier",
      symbol,
      span: toSourceSpan(pattern.syntax),
      bindingKind: pattern.bindingKind,
    };
  }
  if (pattern.kind === "destructure") {
    return {
      kind: "destructure",
      fields: pattern.fields.map((field) => ({
        name: field.name.value,
        pattern: lowerSurfacePattern(field.pattern, ctx, scopes),
      })),
      spread: pattern.spread
        ? lowerSurfacePattern(pattern.spread, ctx, scopes)
        : undefined,
      span: toSourceSpan(pattern.syntax),
    };
  }
  if (pattern.kind === "tuple") {
    return {
      kind: "tuple",
      elements: pattern.elements.map((entry) =>
        lowerSurfacePattern(entry, ctx, scopes),
      ),
      span: toSourceSpan(pattern.syntax),
    };
  }
  if (pattern.kind === "typed") {
    const lowered = lowerSurfacePattern(pattern.pattern, ctx, scopes);
    const typeAnnotation = lowerTypeExpr(
      pattern.typeExpr,
      ctx,
      scopes.current(),
    );
    return {
      ...lowered,
      typeAnnotation,
      span: lowered.span ?? toSourceSpan(pattern.syntax),
    };
  }
  throw new Error("unsupported normalized surface pattern");
};
