import { isList } from "../lib/is-list.mjs";
import { AST, Expr } from "../parser.mjs";
import { greedyOps } from "./greedy-ops.mjs";

export type Associativity = "left" | "right";

/** Key is the operator, value is its [precedence, associativity] */
export const infixOperators = new Map<string, [number, Associativity]>([
  ["+", [0, "left"]],
  ["-", [0, "left"]],
  ["*", [1, "left"]],
  ["/", [1, "left"]],
  ["==", [2, "left"]],
  ["!=", [2, "left"]],
  ["<", [2, "left"]],
  [">", [2, "left"]],
  ["<=", [2, "left"]],
  [">=", [2, "left"]],
  [".", [6, "left"]],
  ["|>", [4, "left"]],
  ["<|", [4, "right"]],
  ["and", [2, "left"]],
  ["or", [2, "left"]],
  ["xor", [2, "left"]],
  ["=", [4, "right"]],
  ["+=", [4, "right"]],
  ["-=", [4, "right"]],
  ["*=", [4, "right"]],
  ["/=", [4, "right"]],
  ["=>", [5, "right"]],
  [":", [6, "right"]],
  [";", [4, "left"]],
  ["??", [3, "right"]],
]);

export const isContinuationOp = (op: string) =>
  isInfixOp(op) && op !== ":" && !greedyOps.has(op); // `:` is a hacky exception (Hopefully the only one.)

export const isInfixOp = (op: string) => infixOperators.has(op);

export const infix = (ast: AST, start: AST = []): AST => {
  const outputQueue: AST = [...start];
  const operatorQueue: string[] = [];

  const opQueueHasHigherOp = (op1: string) => {
    const op2 = operatorQueue.at(-1);
    if (!op2) return false;
    const [op1Precedence, op1Associativity] = infixOperators.get(op1)!;
    const [op2Precedence] = infixOperators.get(op2)!;
    return op2Precedence > op1Precedence || op1Associativity === "left";
  };

  const pushOut = (val: AST) => {
    if (!outputQueue.length && !isOperand(ast[0])) {
      outputQueue.push(...val);
      return;
    }

    outputQueue.push(val);
  };

  const pushDot = (operand1: Expr, operand2: Expr) => {
    if (operand2 instanceof Array) {
      pushOut([operand2[0], operand1, ...operand2.slice(1)]);
      return;
    }

    pushOut([operand2, operand1]);
  };

  const applyLastOperator = () => {
    const b = outputQueue.pop()!; // TODO: Error handling
    const a = outputQueue.pop()!;
    const op = operatorQueue.pop()!;
    if (op === ".") return pushDot(a, b);
    pushOut([op, a, b]);
  };

  while (ast.length) {
    const expr = ast[0];
    if (isOperand(expr)) {
      while (opQueueHasHigherOp(expr)) {
        applyLastOperator();
      }
      operatorQueue.push(expr);
      ast.shift();
      continue;
    }

    isList(expr) ? outputQueue.push(infix(expr)) : outputQueue.push(expr);
    ast.shift();

    if (!isOperand(ast.at(0) ?? false)) break;
  }

  while (operatorQueue.length) {
    applyLastOperator();
  }

  if (ast.length) return infix(ast, outputQueue);
  return outputQueue;
};

const isOperand = (expr: Expr): expr is string =>
  typeof expr === "string" && isInfixOp(expr);
