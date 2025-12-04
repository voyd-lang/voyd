import {
  type Expr,
  type Form,
  isForm,
  isIdentifierAtom,
  isInternalIdentifierAtom,
} from "../../../parser/index.js";
import { toSourceSpan } from "../../utils.js";
import type { HirBindingKind, HirPattern } from "../../hir/index.js";
import type { LowerContext, LowerScopeStack } from "../types.js";
import { resolveSymbol } from "../resolution.js";
import { lowerTypeExpr } from "../type-expressions.js";

export const lowerPattern = (
  pattern: Expr | undefined,
  ctx: LowerContext,
  scopes: LowerScopeStack
): HirPattern => {
  if (!pattern) {
    throw new Error("missing pattern");
  }

  const { target, bindingKind } = unwrapMutablePattern(pattern);

  if (isIdentifierAtom(target)) {
    if (target.value === "_") {
      return { kind: "wildcard", span: toSourceSpan(pattern) };
    }
    const symbol = resolveSymbol(target.value, scopes.current(), ctx);
    return {
      kind: "identifier",
      symbol,
      span: toSourceSpan(pattern),
      bindingKind,
    };
  }

  if (
    isForm(target) &&
    (target.calls("tuple") || target.callsInternal("tuple"))
  ) {
    if (bindingKind && bindingKind !== "value") {
      throw new Error("mutable reference patterns must bind identifiers");
    }
    const elements = target.rest.map((entry) =>
      lowerPattern(entry, ctx, scopes)
    );
    return { kind: "tuple", elements, span: toSourceSpan(pattern) };
  }

  if (isForm(target) && target.calls(":")) {
    const nameExpr = target.at(1);
    const typeExpr = target.at(2);
    if (!typeExpr) {
      throw new Error("typed pattern is missing a type annotation");
    }
    const { target: nameTarget, bindingKind: nameBinding } =
      unwrapMutablePattern(nameExpr);
    const lowered = lowerPattern(nameTarget, ctx, scopes);
    const typeAnnotation = lowerTypeExpr(typeExpr, ctx, scopes.current());
    return {
      ...lowered,
      typeAnnotation,
      bindingKind: nameBinding ?? lowered.bindingKind ?? bindingKind,
      span: lowered.span ?? toSourceSpan(pattern),
    };
  }

  throw new Error("unsupported pattern form");
};

export const unwrapMutablePattern = (
  pattern?: Expr
): { target: Expr; bindingKind?: HirBindingKind } => {
  if (!pattern) {
    throw new Error("missing pattern");
  }

  if (isForm(pattern) && pattern.calls("~")) {
    const target = pattern.at(1);
    if (!target) {
      throw new Error("mutable pattern missing target");
    }
    return { target, bindingKind: "mutable-ref" };
  }

  return { target: pattern };
};
