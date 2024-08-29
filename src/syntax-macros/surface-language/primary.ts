import { infixOps, isPrefixOp, prefixOps } from "../../lib/grammar.js";
import { Expr, List } from "../../syntax-objects/index.js";

/**
 * Primary surface language syntax macro. Post whitespace interpretation.
 * In charge of operator parsing and precedence.
 */
export const primary = (list: List): List => parseList(list);

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

  const result =
    !hadSingleListChild && transformed.at(0)?.isList()
      ? transformed.listAt(0).push(...transformed.rest())
      : transformed;

  // Handle expressions to the right of a label { a: hello there, b: 2 } -> [object [: a [hello there] b [2]]
  if (result.calls(":") && result.length > 3) {
    return result.slice(0, 2).push(result.slice(2));
  }

  return result;
};

const parseBinaryCall = (left: Expr, list: List): List => {
  const op = list.consume();

  const right = parsePrecedence(list, (infixOpInfo(op) ?? -1) + 1);

  // Dot handling should maybe be moved to a macro?
  const result = isDotOp(op)
    ? parseDot(right, left)
    : new List({ value: [op, left, right] });

  // Remove "tuple" from the list of parameters of a lambda
  // Functional notation macro isn't smart enough to identify lambda parameters
  // and so it converts those parameters to a tuple. We remove it here for now.
  if (isLambdaWithTupleArgs(result)) {
    return removeTupleFromLambdaParameters(result);
  }

  return result;
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
  if (!op?.isIdentifier() || op.isQuoted) return undefined;
  return infixOps.get(op.value);
};

const unaryOpInfo = (op?: Expr): number | undefined => {
  if (!op?.isIdentifier()) return undefined;
  return prefixOps.get(op.value);
};

const isLambdaWithTupleArgs = (list: List) =>
  list.calls("=>") && list.at(1)?.isList() && list.listAt(1).calls("tuple");

const removeTupleFromLambdaParameters = (list: List) => {
  const parameters = list.listAt(1);
  parameters.remove(0);
  return list;
};
