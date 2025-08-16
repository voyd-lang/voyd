import { infixOps, isInfixOp, isPrefixOp, prefixOps } from "../grammar.js";
import { Expr, List } from "../../syntax-objects/index.js";

/**
 * Primary surface language syntax macro. Post whitespace interpretation.
 * In charge of operator parsing and precedence. Operator-precedence parser
 */
export const primary = (list: List): List => parseList(list);

const parseExpression = (expr: Expr): Expr => {
  if (!expr.isList()) return expr;
  return parseList(expr);
};

const parseList = (list: List): List => {
  const hadSingleListChild = list.length === 1 && list.at(0)?.isList();

  const finalize = (transformed: List): List => {
    const result =
      !hadSingleListChild && transformed.at(0)?.isList()
        ? transformed.listAt(0).push(...transformed.argsArray())
        : transformed;

    // Handle expressions to the right of an operator { a: hello there, b: 2 } -> [object [: a [hello there] b [2]]
    if (
      result.at(0)?.isIdentifier() &&
      isInfixOp(result.identifierAt(0)) &&
      result.length > 3
    ) {
      return result.slice(0, 2).push(parseList(result.slice(2)));
    }

    return result;
  };

  let hasOp = false;
  for (let i = 0; i < list.length; i++) {
    const child = list.at(i);
    if (child?.isIdentifier() && (isPrefixOp(child) || isInfixOp(child))) {
      hasOp = true;
      break;
    }
  }

  const transformed = new List({ ...list.metadata, dynamicLocation: true });

  if (!hasOp) {
    for (let i = 0; i < list.length; i++) {
      transformed.push(parseExpression(list.at(i)!));
    }
    return finalize(transformed);
  }

  while (list.hasChildren) {
    transformed.push(parsePrecedence(list));
  }

  return finalize(transformed);
};

const parseBinaryCall = (left: Expr, list: List): List => {
  const op = list.consume();

  const right = parsePrecedence(list, (infixOpInfo(op) ?? -1) + 1);

  // Dot handling should maybe be moved to a macro?
  const result = isDotOp(op)
    ? parseDot(right, left)
    : new List({
        ...op.metadata,
        value: [op, left, right],
        dynamicLocation: true,
      });

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
  if (
    right.isList() &&
    right.at(1)?.isList() &&
    right.listAt(1).calls("generics")
  ) {
    right.insert(left, 2);
    return right;
  }

  if (right.isList()) {
    right.insert(left, 1);
    return right;
  }

  return new List({ value: [right, left], dynamicLocation: true });
};

const parsePrecedence = (list: List, minPrecedence = 0): Expr => {
  const next = list.at(0);
  let expr = isPrefixOp(next)
    ? parseUnaryCall(list)
    : parseExpression(list.consume());

  let nextPrecedence: number | undefined;
  while (
    list.hasChildren &&
    (nextPrecedence = infixOpInfo(list.first())) !== undefined &&
    nextPrecedence >= minPrecedence
  ) {
    expr = parseBinaryCall(expr, list);
  }

  return expr;
};

const parseUnaryCall = (list: List): List => {
  const op = list.consume();
  const expr = parsePrecedence(list, unaryOpInfo(op) ?? -1);
  return new List({ value: [op, expr], dynamicLocation: true });
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
