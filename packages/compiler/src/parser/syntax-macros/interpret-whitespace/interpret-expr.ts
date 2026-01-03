import {
  CallForm,
  Expr,
  Form,
  FormCursor,
  FormInitElements,
} from "../../ast/index.js";
import { IdentifierAtom, isIdentifierAtom } from "../../ast/index.js";
import * as p from "../../ast/predicates.js";
import { isContinuationOp, isGreedyOp, isOp } from "../../grammar.js";
import { normalizeFormKind, unwrapSyntheticCall } from "./shared.js";
import { extractLeadingContinuationOp } from "./suite-sugar.js";
import { hoistTrailingBlock } from "./trailing-block.js";

/**
 * Core whitespace interpreter that turns indentation into explicit `block(...)`
 * forms while recursively rewriting nested list expressions.
 */
export const interpretWhitespaceExpr = (
  form: Form,
  indentLevel?: number
): Expr => {
  const cursor = form.cursor();
  const transformed: Expr[] = [];

  while (!cursor.done) {
    const child = elideParens(cursor, indentLevel);
    if (p.isForm(child) && !child.length) continue;
    addSibling(child, transformed);
  }

  const newForm = new Form(transformed);
  const normalizedForm: Form =
    newForm.length === 1 && p.isForm(newForm.first) ? newForm.first : newForm;
  const preserved = normalizeFormKind(form, normalizedForm);
  if (form.location) preserved.setLocation(form.location.clone());

  const normalized = hoistTrailingBlock(preserved);
  return p.isForm(normalized) ? normalized.unwrap() : normalized;
};

const elideParens = (cursor: FormCursor, startIndentLevel?: number): Expr => {
  const transformed: FormInitElements = [];
  const parenthesized: boolean[] = [];
  const indentLevel = startIndentLevel ?? nextExprIndentLevel(cursor);

  const pushElement = (
    expr: FormInitElements[number],
    isParenthesized = false
  ) => {
    transformed.push(expr);
    parenthesized.push(isParenthesized);
  };

  const popElement = () => {
    parenthesized.pop();
    return transformed.pop();
  };

  const asExpr = (
    element: FormInitElements[number] | undefined
  ): Expr | undefined =>
    !element || typeof element === "string" || Array.isArray(element)
      ? undefined
      : element;

  const maybeMergeConstructorObjectLiteral = () => {
    if (transformed.length < 2) return;
    const objectLiteral = asExpr(transformed.at(-1));
    const callee = asExpr(transformed.at(-2));
    const calleeIsParenthesized = parenthesized.at(-2) ?? false;
    if (
      objectLiteral &&
      callee &&
      isObjectLiteral(objectLiteral) &&
      !calleeIsParenthesized &&
      isUpperCamelConstructorTarget(callee)
    ) {
      popElement();
      popElement();
      pushElement(new CallForm([callee, objectLiteral]));
    }
  };

  const pushChildBlock = () => {
    const children: Expr[] = [new IdentifierAtom("block")];

    while (nextExprIndentLevel(cursor) > indentLevel) {
      const child = elideParens(cursor, indentLevel + 1);

      const continuationOp = extractLeadingContinuationOp(child, children);
      if (continuationOp !== undefined) {
        continuationOp.forEach((entry) => pushElement(entry));
        return;
      }

      addSibling(child, children);
    }

    pushElement(new CallForm(children));
  };

  consumeLeadingWhitespace(cursor);
  while (!cursor.done) {
    const next = cursor.peek();

    if (isNewline(next)) {
      const nextIndent = nextExprIndentLevel(cursor);
      if (nextIndent > indentLevel) {
        pushChildBlock();
        continue;
      }

      if (!isContinuationOp(transformed.at(-1))) break;
    }

    if (p.isWhitespaceAtom(next)) {
      cursor.consume();
      continue;
    }

    if (p.isForm(next)) {
      cursor.consume();
      const isParen = next.callsInternal("paren");
      const expr = isParen
        ? elideParens(next.slice(1).cursor(), indentLevel)
        : interpretWhitespaceExpr(next, indentLevel);
      pushElement(expr, isParen);
      maybeMergeConstructorObjectLiteral();
      continue;
    }

    if (isGreedyOp(next)) {
      const op = cursor.consume()!;
      pushElement(op);

      if (nextExprIndentLevel(cursor) <= indentLevel) {
        pushElement(elideParens(cursor, indentLevel));
      }

      continue;
    }

    const consumed = cursor.consume();
    if (!consumed) break;
    pushElement(consumed);
    maybeMergeConstructorObjectLiteral();
  }

  return new Form(transformed).unwrap();
};

type IndentCacheEntry = { position: number; indent: number };
const indentLookaheadCache = new WeakMap<FormCursor, IndentCacheEntry>();

/**
 * Returns the indentation level of the next expression by counting consecutive
 * indent atoms after the most recent newline. Uses a tiny per-cursor cache since
 * callers often query the same position twice.
 */
const nextExprIndentLevel = (cursor: FormCursor) => {
  const cached = indentLookaheadCache.get(cursor);
  if (cached && cached.position === cursor.position) {
    return cached.indent;
  }

  let nextIndentLevel = 0;
  let offset = 0;

  while (true) {
    const expr = cursor.peek(offset);
    if (!expr) {
      nextIndentLevel = 0;
      break;
    }

    if (isNewline(expr)) {
      nextIndentLevel = 0;
      offset += 1;
      continue;
    }

    if (isIndent(expr)) {
      nextIndentLevel += 1;
      offset += 1;
      continue;
    }

    break;
  }

  indentLookaheadCache.set(cursor, {
    position: cursor.position,
    indent: nextIndentLevel,
  });

  return nextIndentLevel;
};

const consumeLeadingWhitespace = (cursor: FormCursor) => {
  cursor.consumeWhile((expr) => p.isWhitespaceAtom(expr));
};

const isNewline = (v?: Expr) => p.isWhitespaceAtom(v) && v.isNewline;
const isIndent = (v?: Expr) => p.isWhitespaceAtom(v) && v.isIndent;

const isObjectLiteral = (expr: Expr): expr is Form =>
  p.isForm(expr) && (expr as Form).callsInternal("object_literal");

const isUpperCamelCase = (value: string): boolean => {
  const first = value[0];
  if (!first) return false;
  return first.toUpperCase() === first && first.toLowerCase() !== first;
};

const isUpperCamelConstructorTarget = (expr: Expr | undefined): boolean => {
  if (!expr) return false;

  if (isIdentifierAtom(expr)) {
    return !expr.isQuoted && isUpperCamelCase(expr.value);
  }

  if (
    !p.isForm(expr) ||
    expr.callsInternal("paren") ||
    expr.callsInternal("tuple")
  ) {
    return false;
  }

  const head = expr.at(0);
  if (!isIdentifierAtom(head) || isOp(head) || head.isQuoted) {
    return false;
  }

  return isUpperCamelCase(head.value);
};

/**
 * Accumulates siblings in a call-like expression.
 */
export const addSibling = (child: Expr, siblings: Expr[]) => {
  const normalizedChild = unwrapSyntheticCall(child);
  siblings.push(normalizedChild);
};
