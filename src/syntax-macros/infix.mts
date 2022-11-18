import { AST, Expr } from "../parser.mjs";

export const infixOperators = new Set([
  "+",
  "-",
  "*",
  "/",
  "=",
  "==",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
  ".",
]);

export const infix = (ast: AST) => {
  const transformed: AST = [];

  const shift = (): Expr => {
    const val = ast.shift();
    if (val instanceof Array) return infix(val);
    return val!;
  };

  const operatorIsNext = () => {
    const next = ast[0];
    return isOperand(next);
  };

  const push = (op: Expr, operand1: Expr, operand2: Expr) => {
    if (transformed.length !== 0 || operatorIsNext()) {
      transformed.push([op, operand1, operand2]);
      return;
    }

    transformed.push(op, operand1, operand2);
  };

  while (ast.length) {
    const operand1 = shift();

    if (isOperand(operand1) && transformed.length && ast.length >= 1) {
      const operand2 = shift();
      push(operand1, transformed.pop()!, operand2);
      continue;
    }

    if (operatorIsNext() && ast.length >= 2) {
      const op = shift();
      const operand2 = shift();
      push(op, operand1, operand2);
      continue;
    }

    transformed.push(operand1);
  }

  return transformed;
};

const isOperand = (expr: Expr) =>
  typeof expr === "string" && infixOperators.has(expr);
