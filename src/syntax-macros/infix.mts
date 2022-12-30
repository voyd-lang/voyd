import {
  Expr,
  Identifier,
  isIdentifier,
  isList,
  List,
} from "../lib/syntax.mjs";
import { greedyOps } from "./greedy-ops.mjs";

export type Associativity = "left" | "right";

/** Key is the operator, value is its [precedence, associativity] */
export const infixOperators = new Map<string, [number, Associativity]>([
  ["+", [1, "left"]],
  ["-", [1, "left"]],
  ["*", [2, "left"]],
  ["/", [2, "left"]],
  ["and", [0, "left"]],
  ["or", [0, "left"]],
  ["xor", [0, "left"]],
  ["==", [0, "left"]],
  ["!=", [0, "left"]],
  ["<", [0, "left"]],
  [">", [0, "left"]],
  ["<=", [0, "left"]],
  [">=", [0, "left"]],
  [".", [6, "left"]],
  ["|>", [4, "left"]],
  ["<|", [4, "right"]],
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

export const infix = (list: List, startList?: List): List => {
  const outputQueue = startList ?? new List({ context: list });
  const operatorQueue: Identifier[] = [];

  const opQueueHasHigherOp = (op1: Identifier) => {
    const op2 = operatorQueue.at(-1);
    if (!op2) return false;
    const [op1Precedence, op1Associativity] = infixOperators.get(op1.value)!;
    const [op2Precedence] = infixOperators.get(op2.value)!;
    return (
      op2Precedence > op1Precedence ||
      (op2Precedence === op1Precedence && op1Associativity === "left")
    );
  };

  const pushOut = (value: Expr[]) => {
    if (!outputQueue.hasChildren && !isOperand(list.first())) {
      outputQueue.push(...value);
      return;
    }

    outputQueue.push(new List({ value }));
  };

  const pushDot = (operand1: Expr, operand2: Expr) => {
    if (isList(operand2)) {
      pushOut([operand2.consume(), operand1, ...operand2.value]);
      return;
    }

    pushOut([operand2, operand1]);
  };

  const applyLastOperator = () => {
    const b = outputQueue.pop()!;
    const a = outputQueue.pop()!;
    const op = operatorQueue.pop()!;
    if (op.is(".")) return pushDot(a, b);
    pushOut([op, a, b]);
  };

  while (list.hasChildren) {
    const expr = list.consume();
    if (isOperand(expr)) {
      while (opQueueHasHigherOp(expr)) {
        applyLastOperator();
      }
      operatorQueue.push(expr);
      continue;
    }

    isList(expr) ? outputQueue.push(infix(expr)) : outputQueue.push(expr);

    if (!isOperand(list.first())) break;
  }

  while (operatorQueue.length) {
    applyLastOperator();
  }

  if (list.hasChildren) return infix(list, outputQueue);
  return outputQueue;
};

export const isOperand = (expr?: Expr): expr is Identifier =>
  isIdentifier(expr) && isInfixOp(expr.value);
