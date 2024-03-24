import { Expr } from "../syntax-objects/expr.mjs";
import { Identifier } from "../syntax-objects/identifier.mjs";

export const isTerminator = (char: string) =>
  isWhitespace(char) ||
  char === "," ||
  isBracket(char) ||
  isQuote(char) ||
  isOpChar(char);

export const isQuote = newTest(["'", '"', "`"]);

export const isWhitespace = (char: string) => /\s/.test(char);

export const isBracket = newTest(["{", "[", "(", ")", "]", "}"]);

export const isOpChar = newTest([
  "+",
  "-",
  "*",
  "/",
  "=",
  ":",
  "?",
  ".",
  ";",
  "<",
  ">",
  "$",
  "!",
  "@",
  "%",
  "^",
  "&",
  "~",
  "\\",
  "#",
]);

export const isDigit = (char: string) => /[0-9]/.test(char);
export const isDigitSign = (char: string) => char === "+" || char === "-";

export type Associativity = "left" | "right";

/** Key is the operator, value is its [precedence, associativity] */
export type InfixOpMap = Map<string, [number, Associativity]>;

/** Key is the operator, value is its precedence */
export type UnaryOpMap = Map<string, number>;

export const infixOps: InfixOpMap = new Map([
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
  ["<|", [4, "right"]],
  ["|", [4, "left"]],
  ["&", [4, "left"]],
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

export const isInfixOp = (op?: Expr): op is Identifier =>
  !!op?.isIdentifier() && isInfixOpIdentifier(op);

export const isInfixOpIdentifier = (op?: Identifier) =>
  !!op && !op.isQuoted && infixOps.has(op.value);

export const prefixOps: UnaryOpMap = new Map([
  ["#", 7],
  ["&", 7],
  ["!", 7],
  ["~", 7],
  ["%", 7],
  ["...", 5],
]);

// let x = ...a.hey + &b.there
// [let
//   [= x
//     [+
//       [... [. a hey]]
//       [. [& b] there]]]]

export const isPrefixOp = (op?: Expr): op is Identifier =>
  !!op?.isIdentifier() && isPrefixOpIdentifier(op);

export const isPrefixOpIdentifier = (op?: Identifier) =>
  !!op && !op.isQuoted && prefixOps.has(op.value);

export const greedyOps = new Set(["=>", "=", "<|", ";", "|"]);

export const isGreedyOp = (expr?: Expr): expr is Identifier => {
  if (!expr?.isIdentifier()) return false;
  return isGreedyOpIdentifier(expr);
};

export const isGreedyOpIdentifier = (op?: Identifier) =>
  !!op && !op.isQuoted && greedyOps.has(op.value);

export const isContinuationOp = (op?: Expr) =>
  isInfixOp(op) && !op.is(":") && !greedyOps.has(op.value); // `:` is a hacky exception (Hopefully the only one.)

function newTest<T>(list: Set<T> | Array<T>) {
  const set = new Set(list);
  return (val: T) => set.has(val);
}
