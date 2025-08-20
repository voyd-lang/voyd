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
  const items: Expr[] = [];

  while (list.hasChildren) {
    items.push(parsePrecedence(list));
  }

  let result: List;
  if (!hadSingleListChild && items[0]?.isList()) {
    result = items[0] as List;
    result.push(...items.slice(1));
  } else {
    result = new List({ ...list.metadata, value: items, dynamicLocation: true });
  }

  // Handle expressions to the right of an operator { a: hello there, b: 2 } -> [object [: a [hello there] b [2]]
  if (
    result.at(0)?.isIdentifier() &&
    isInfixOp(result.identifierAt(0)) &&
    result.length > 3
  ) {
    const head = new List({
      ...result.metadata,
      dynamicLocation: true,
      value: [result.exprAt(0), result.exprAt(1)],
    });

    const tail = new List({
      ...result.metadata,
      dynamicLocation: true,
      value: result.sliceAsArray(2),
    });

    head.push(parseList(tail));
    return head;
  }

  return result;
};

const isDotOp = (op?: Expr): boolean => {
  return !!op?.isIdentifier() && op.is(".");
};

const parseDot = (right: Expr, left: Expr): List => {
  if (right.isList() && right.calls("=>")) {
    return new List({ value: ["call", right, left], dynamicLocation: true });
  }
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
  const first = list.first();
  let expr: Expr;

  if (isPrefixOp(first)) {
    const op = list.consume();
    const right = parsePrecedence(list, unaryOpInfo(op) ?? -1);
    expr = new List({ value: [op, right], dynamicLocation: true });
  } else {
    expr = parseExpression(list.consume());
  }

  while (list.hasChildren) {
    const op = list.first()!;
    const precedence = infixOpInfo(op);
    if (precedence === undefined || precedence < minPrecedence) break;

    list.consume();
    const right = parsePrecedence(list, precedence + 1);

    expr = isDotOp(op)
      ? parseDot(right, expr)
      : new List({
          ...op.metadata,
          value: [op, expr, right],
          dynamicLocation: true,
        });

    if (isLambdaWithTupleArgs(expr)) {
      expr = removeTupleFromLambdaParameters(expr);
    }
  }

  return expr;
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
