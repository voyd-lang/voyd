import {
  infixOps,
  isGreedyOp,
  isInfixOp,
  isInfixOpIdentifier,
  isPrefixOpIdentifier,
} from "../../lib/grammar.mjs";
import { Expr, Identifier, List } from "../../syntax-objects/index.mjs";

/**
 * Primary surface language macro. Post whitespace interpretation.
 * In charge of operator parsing and precedence.
 */
export const primary = (list: List): List => list.map(primary_expression);

const primary_expression = (expr: Expr): Expr => {
  if (expr.isList()) return parse_list(expr);
  return expr;
};

const parse_list = (list: List): List => {
  const transformed = new List({ ...list.metadata });

  while (list.hasChildren) {
    const expr = primary_expression(list.consume());
    const next = list.first();

    if (!next?.isIdentifier()) {
      transformed.push(expr);
      continue;
    }

    if (isInfixOpIdentifier(next)) {
      transformed.push(precedenceClimb(expr, list));
      continue;
    }

    if (isPrefixOpIdentifier(next)) {
    }

    transformed.push(expr);
  }

  if (transformed.length.value === 1 && transformed.first()?.isList()) {
    return transformed.first() as List;
  }

  return transformed;
};

// TODO: Cleanup with https://chidiwilliams.com/posts/on-recursive-descent-and-pratt-parsing#:~:text=Pratt%20parsing%20describes%20an%20alternative,an%20identifier%2C%20or%20a%20unary.
const precedenceClimb = (lhs: Expr, rest: List, minPrecedence = 0): Expr => {
  if (isGreedyOp(rest.first())) {
    rest = processGreedyOp(rest);
  }

  let opInfo = getOpInfo(rest.first());
  while (opInfo.type === "infix" && opInfo.precedence >= minPrecedence) {
    rest.consume();
    let rhs = primary_expression(rest.consume());
    const oldOpInfo = opInfo;
    opInfo = getOpInfo(rest.first());
    while (
      opInfo.type == "infix" &&
      (opInfo.precedence > oldOpInfo.precedence ||
        (opInfo.associativity === "right" &&
          opInfo.precedence === oldOpInfo.precedence))
    ) {
      rhs = precedenceClimb(
        rhs,
        rest,
        oldOpInfo.precedence + opInfo.precedence > oldOpInfo.precedence ? 1 : 0
      );
      opInfo = getOpInfo(rest.first());
    }

    const value = op.value === "." ? [lhs, rhs] : [op, lhs, rhs];
    lhs = new List({ value });
  }

  return lhs;
};

const binary = (lhs: Expr, op: InfixOp, rest: List): List => {
  const rhs = precedenceClimb(lhs, rest, op.precedence + 1);
  const value = op.op.value === "." ? [lhs, rhs] : [op.op, lhs, rhs];
  return new List({ value });
};

const processGreedyOp = (list: List) => {
  const transformed = new List({ ...list.metadata });
  while (list.hasChildren) {
    const next = list.consume();

    if (next.isList()) {
      transformed.push(processGreedyOp(next));
      continue;
    }

    if (isGreedyOp(next)) {
      transformed.push(next);
      const consumed = processGreedyOp(list);
      const result = consumed.value.length === 1 ? consumed.first()! : consumed;
      transformed.push(result);
      continue;
    }

    transformed.push(next);
  }

  return transformed;
};

type OpInfo = { type: "n/a" } | InfixOp;

type InfixOp = {
  type: "infix";
  precedence: number;
  associativity: "right" | "left";
  op: Identifier;
};

const getOpInfo = (op?: Expr): OpInfo => {
  if (!isInfixOp(op)) return { type: "n/a" };
  const info = infixOps.get(op.value);
  if (!info) return { type: "n/a" };
  return { type: "infix", precedence: info[0], associativity: info[1], op };
};
