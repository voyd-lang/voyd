import { Expr, FormInitElements } from "../../ast/index.js";
import * as p from "../../ast/predicates.js";
import { isContinuationOp } from "../../grammar.js";

/**
 * Extracts a leading continuation operator that binds the current indented suite
 * back to the parent expression.
 */
export const extractLeadingContinuationOp = (
  child: Expr,
  children: Expr[]
): FormInitElements | undefined => {
  if (
    children.length !== 1 ||
    !p.isForm(child) ||
    !isContinuationOp(child.first)
  ) {
    return undefined;
  }

  const elements = child.toArray();
  const head = elements.at(0);
  if (!head) return [];
  const tail = elements.slice(1);
  if (tail.length === 0) return [head];
  return [head, tail.length === 1 ? tail[0]! : tail];
};
