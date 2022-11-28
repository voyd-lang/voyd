import { AST, Expr } from "../parser.mjs";

export const infixOperators = new Set([
  "+",
  "-",
  "*",
  "/",
  "==",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
  ".",
  "|>",
  "<|",
  "and",
  "or",
  "=", // Not considered a continuation for parenthetical elision
  "=>", // Not considered a continuation for parenthetical elision
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

  const push = (ast: AST) => {
    if (transformed.length !== 0 || operatorIsNext()) {
      transformed.push(ast);
      return;
    }

    transformed.push(...ast);
  };

  const pushDot = (operand1: Expr, operand2: Expr) => {
    if (operand2 instanceof Array) {
      push([operand2[0], operand1, ...operand2.slice(1)]);
      return;
    }

    push([operand2, operand1]);
  };

  const pushOperation = (op: Expr, operand1: Expr, operand2: Expr) => {
    if (op === ".") return pushDot(operand1, operand2);
    push([op, operand1, operand2]);
  };

  while (ast.length) {
    const operand1 = shift();

    if (isOperand(operand1) && transformed.length && ast.length >= 1) {
      const operand2 = shift();
      pushOperation(operand1, transformed.pop()!, operand2);
      continue;
    }

    if (operatorIsNext() && ast.length >= 2) {
      const op = shift();
      const operand2 = shift();
      pushOperation(op, operand1, operand2);
      continue;
    }

    transformed.push(operand1);
  }

  return transformed;
};

const isOperand = (expr: Expr) =>
  typeof expr === "string" && infixOperators.has(expr);
