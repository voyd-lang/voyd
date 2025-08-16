import { Expr } from "../syntax-objects/expr.js";
import { Identifier } from "../syntax-objects/identifier.js";

export const idIs = (id: Expr | undefined, value: string) =>
  id?.isIdentifier() && id.is(value);

export const isTerminator = (char: string) =>
  isWhitespace(char) ||
  isBracket(char) ||
  isQuote(char) ||
  isOpChar(char) ||
  char === ",";

export const isQuote = newTest(["'", '"', "`"]);

export const isWhitespace = (char: string) =>
  char === " " || char === "\n" || char === "\r";

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

export const isDigit = (char: string) => char >= "0" && char <= "9";
export const isDigitSign = (char: string) => char === "+" || char === "-";

/** Key is the operator, value is its precedence */
export type OpMap = Map<string, number>;

export const infixOps: OpMap = new Map([
  ["+", 1],
  ["-", 1],
  ["*", 2],
  ["/", 2],
  ["^", 3],
  ["%", 2],
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
  ["->", 5],
  ["=>", 5],
  [":", 0],
  ["?:", 0],
  ["::", 0],
  [";", 4],
  ["??", 3],
  ["and", 0],
  ["or", 0],
  ["xor", 0],
  ["as", 0],
  ["is", 0],
  ["is_subtype_of", 0],
  ["in", 0],
  ["has_trait", 0],
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
