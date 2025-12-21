import { Expr, Form } from "../../ast/index.js";
import * as p from "../../ast/predicates.js";
import { isCallLikeForm, isNonBindingOp, normalizeFormKind, rebuildSameKind } from "./shared.js";

/**
 * Hoists a trailing `block(...)` out of operator chains so it attaches to the
 * outermost call-like expression.
 */
export function hoistTrailingBlock(expr: Form): Form;
export function hoistTrailingBlock(expr: Expr): Expr;
export function hoistTrailingBlock(expr: Expr): Expr {
  if (!p.isForm(expr)) return expr;

  const elements = expr.toArray().map(hoistTrailingBlock);
  const cloned = new Form({
    location: expr.location?.clone(),
    elements,
  });

  if (!isCallLikeForm(cloned)) {
    return normalizeFormKind(expr, cloned);
  }

  const { expr: withoutBlock, block } = splitTrailingBlock(cloned);
  if (!block || !p.isForm(withoutBlock)) {
    return normalizeFormKind(expr, cloned);
  }

  const hoisted = new Form({
    location: cloned.location?.clone(),
    elements: [...withoutBlock.toArray(), block],
  });

  return normalizeFormKind(expr, hoisted);
}

type TrailingBlockExtraction = { expr?: Expr; block?: Form };

const shouldDescendForTrailingBlock = (child: Form, previous?: Expr): boolean =>
  isNonBindingOp(child.first) || isNonBindingOp(previous);

const splitTrailingBlock = (expr: Expr): TrailingBlockExtraction => {
  if (!p.isForm(expr)) return { expr };

  const elements = expr.toArray();
  const last = elements.at(-1);
  if (!last) return { expr };

  if (p.isForm(last) && last.calls("block")) {
    return {
      expr: rebuildSameKind(expr, elements.slice(0, -1)),
      block: last,
    };
  }

  const previous = elements.at(-2);
  if (p.isForm(last) && shouldDescendForTrailingBlock(last, previous)) {
    const { expr: trimmedLast, block } = splitTrailingBlock(last);
    if (!block) return { expr };

    const remaining = elements.slice(0, -1);
    if (trimmedLast && !(p.isForm(trimmedLast) && trimmedLast.length === 0)) {
      remaining.push(trimmedLast);
    }

    return {
      expr: rebuildSameKind(expr, remaining),
      block,
    };
  }

  return { expr };
};
