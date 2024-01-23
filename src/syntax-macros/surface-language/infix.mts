import { Expr, Identifier, List } from "../../syntax-objects/index.mjs";
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
  ["as", [0, "left"]],
  ["is", [0, "left"]],
  ["in", [0, "left"]],
  ["==", [0, "left"]],
  ["!=", [0, "left"]],
  ["<", [0, "left"]],
  [">", [0, "left"]],
  ["<=", [0, "left"]],
  [">=", [0, "left"]],
  [".", [6, "left"]],
  ["|>", [4, "left"]],
  ["|", [4, "left"]],
  ["<|", [4, "right"]],
  ["=", [0, "left"]],
  ["+=", [4, "right"]],
  ["-=", [4, "right"]],
  ["*=", [4, "right"]],
  ["/=", [4, "right"]],
  ["=>", [5, "right"]],
  [":", [0, "left"]],
  ["::", [0, "left"]],
  [";", [4, "left"]],
  ["??", [3, "right"]],
]);

export const isContinuationOp = (op?: Expr) =>
  isInfixOp(op) && !op.is(":") && !greedyOps.has(op.value); // `:` is a hacky exception (Hopefully the only one.)

export const isInfixOp = (op?: Expr): op is Identifier =>
  !!op?.isIdentifier() && !op.isQuoted && infixOperators.has(op.value);

export const infix = (list: List, startList?: List): List => {
  const outputQueue = startList ?? new List({ ...list.context });
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

  const pushOut = (value: Expr[], currentExpr?: Expr) => {
    // Ensure we don't duplicate wrapping parenthesis
    if (!outputQueue.hasChildren && !isOperand(currentExpr)) {
      outputQueue.push(...value);
      return;
    }

    outputQueue.push(new List({ value }));
  };

  const pushDot = (operand1: Expr, operand2: Expr, currentExpr?: Expr) => {
    if (operand2.isList()) {
      pushOut([operand2.consume(), operand1, ...operand2.value], currentExpr);
      return;
    }

    pushOut([operand2, operand1], currentExpr);
  };

  const applyLastOperator = (currentExpr?: Expr) => {
    const b = outputQueue.pop()!;
    const a = outputQueue.pop()!;
    const op = operatorQueue.pop()!;
    if (op.is(".")) return pushDot(a, b, currentExpr);
    pushOut([op, a, b], currentExpr);
  };

  while (list.hasChildren) {
    const expr = list.consume();
    if (isOperand(expr)) {
      while (opQueueHasHigherOp(expr)) {
        applyLastOperator(expr);
      }
      operatorQueue.push(expr);
      continue;
    }

    expr.isList() ? outputQueue.push(infix(expr)) : outputQueue.push(expr);

    if (!isOperand(list.first())) break;
  }

  while (operatorQueue.length) {
    applyLastOperator();
  }

  if (list.hasChildren) return infix(list, outputQueue);
  return outputQueue;
};

export const isOperand = (expr?: Expr): expr is Identifier =>
  !!expr?.isIdentifier() && isInfixOp(expr);
