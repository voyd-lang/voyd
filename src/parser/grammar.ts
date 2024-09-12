import { Expr } from "../syntax-objects/expr.js";
import { Identifier } from "../syntax-objects/identifier.js";

export const isTerminator = (char: string) =>
  isWhitespace(char) ||
  isBracket(char) ||
  isQuote(char) ||
  isOpChar(char) ||
  char === ",";

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

/** Key is the operator, value is its precedence */
export type OpMap = Map<string, number>;

export const infixOps: OpMap = new Map([
  ["+", 1],
  ["-", 1],
  ["*", 2],
  ["/", 2],
  ["and", 0],
  ["or", 0],
  ["xor", 0],
  ["as", 0],
  ["is", 0],
  ["in", 0],
  ["==", 0],
  ["!=", 0],
  ["<", 0],
  [">", 0],
  ["<=", 0],
  [">=", 0],
  [".", 6],
  ["|>", 4],
  ["<|", 4],
  ["|", 4],
  ["&", 4],
  ["=", 0],
  ["+=", 4],
  ["-=", 4],
  ["*=", 4],
  ["/=", 4],
  ["=>", 5],
  [":", 0],
  ["::", 0],
  [";", 4],
  ["??", 3],
]);

export const isInfixOp = (op?: Expr): op is Identifier =>
  !!op?.isIdentifier() && isInfixOpIdentifier(op);

export const isInfixOpIdentifier = (op?: Identifier) =>
  !!op && !op.isQuoted && infixOps.has(op.value);

export const isOp = (op?: Expr): boolean => isInfixOp(op) || isPrefixOp(op);

export const prefixOps: OpMap = new Map([
  ["#", 0],
  ["&", 7],
  ["!", 7],
  ["~", 7],
  ["%", 7],
  ["$", 7],
  ["@", 7],
  ["$@", 7],
  ["...", 5],
]);

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

export const isContinuationOp = (op?: Expr) => isInfixOp(op);

function newTest<T>(list: Set<T> | Array<T>) {
  const set = new Set(list);
  return (val: T) => set.has(val);
}
