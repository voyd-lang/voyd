import {
  infixOps,
  isGreedyOp,
  isPrefixOp,
  prefixOps,
} from "../../lib/grammar.mjs";
import { Expr, Identifier, List } from "../../syntax-objects/index.mjs";

/**
 * Primary surface language syntax macro. Post whitespace interpretation.
 * In charge of operator parsing and precedence.
 */
export const primary = (list: List): List => list.map(parseExpression);

const parseExpression = (expr: Expr): Expr => {
  if (!expr.isList()) return expr;
  return parseList(expr);
};

const parseList = (list: List): List => {
  const transformed = new List({ ...list.metadata });
  const hadSingleListChild = list.length === 1 && list.at(0)?.isList();

  while (list.hasChildren) {
    transformed.push(parsePrecedence(list));
  }

  return transformed.length === 1 &&
    !hadSingleListChild &&
    transformed.at(0)?.isList()
    ? transformed.listAt(0)
    : transformed;
};

const parseBinaryCall = (left: Expr, list: List): List => {
  const op = list.consume();

  const right = isGreedyOp(op)
    ? parseGreedy(list)
    : parsePrecedence(list, (infixOpInfo(op) ?? -1) + 1);

  // Dot handling should maybe be moved to a macro?
  return isDotOp(op)
    ? parseDot(right, left)
    : new List({ value: [op, left, right] });
};

const isDotOp = (op?: Expr): boolean => {
  return !!op?.isIdentifier() && op.is(".");
};

const parseDot = (right: Expr, left: Expr): List => {
  if (right.isList()) {
    right.insert(left, 1);
    return right;
  }

  return new List({ value: [right, left] });
};

const parseGreedy = (list: List): Expr => {
  const result = parseList(list.consumeRest());
  return result.length === 1 ? result.consume() : result;
};

// TODO: Cleanup with https://chidiwilliams.com/posts/on-recursive-descent-and-pratt-parsing#:~:text=Pratt%20parsing%20describes%20an%20alternative,an%20identifier%2C%20or%20a%20unary.
const parsePrecedence = (list: List, minPrecedence = 0): Expr => {
  const next = list.at(0);
  let expr = isPrefixOp(next)
    ? parseUnaryCall(list)
    : parseExpression(list.consume());

  while ((infixOpInfo(list.first()) ?? -1) >= minPrecedence) {
    expr = parseBinaryCall(expr, list);
  }

  return expr;
};

const parseUnaryCall = (list: List): List => {
  const op = list.consume();
  const expr = parsePrecedence(list, unaryOpInfo(op) ?? -1);
  return new List({ value: [op, expr] });
};

const infixOpInfo = (op?: Expr): number | undefined => {
  if (!op?.isIdentifier()) return undefined;
  return infixOps.get(op.value);
};

const unaryOpInfo = (op?: Expr): number | undefined => {
  if (!op?.isIdentifier()) return undefined;
  return prefixOps.get(op.value);
};
