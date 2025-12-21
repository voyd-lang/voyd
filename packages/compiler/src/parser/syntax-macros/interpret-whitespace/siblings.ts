import { Expr, Form, isIdentifierAtom } from "../../ast/index.js";
import * as p from "../../ast/predicates.js";
import { unwrapSyntheticCall } from "./shared.js";

const isNamedArg = (v: Form) => p.atomEq(v.at(1), ":");

/**
 * Accumulates siblings in a call-like expression, merging named args into the
 * preceding call target when appropriate.
 */
export const addSibling = (child: Expr, siblings: Expr[]) => {
  const normalizedChild = unwrapSyntheticCall(child);
  const olderSibling = siblings.at(-1);

  if (!p.isForm(normalizedChild)) {
    siblings.push(normalizedChild);
    return;
  }

  if (!p.isForm(olderSibling) || olderSibling.callsInternal("generics")) {
    siblings.push(normalizedChild);
    return;
  }

  if (isNamedArg(normalizedChild) && !isNamedArg(olderSibling)) {
    siblings.pop();
    siblings.push(
      new Form([...olderSibling.toArray(), ...splitNamedArgs(normalizedChild)])
    );
    return;
  }

  siblings.push(normalizedChild);
};

const splitNamedArgs = (list: Form): Expr[] => {
  const result: Expr[] = [];
  let start = 0;

  for (let i = 2; i < list.length; i += 1) {
    const expr = list.at(i);
    const next = list.at(i + 1);
    if (isIdentifierAtom(expr) && p.atomEq(next, ":")) {
      result.push(list.slice(start, i));
      start = i;
    }
  }

  result.push(list.slice(start));
  return result;
};

