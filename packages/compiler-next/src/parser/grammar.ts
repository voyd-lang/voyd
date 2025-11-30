import { Atom } from "./ast/atom.js";
import { isIdentifierAtom } from "./ast/predicates.js";

export const identifierIs = (op: unknown, value: string): op is Atom =>
  isIdentifierAtom(op) && op.eq(value);

export const isOp = (op?: unknown): boolean => isInfixOp(op) || isPrefixOp(op);

/** Key is the operator, value is its precedence */
export type OpMap = Map<string, number>;

export const infixOps: OpMap = new Map([
  ["+", 1],
  ["-", 1],
  ["*", 2],
  ["/", 2],
  ["^", 3],
  ["%", 2],
  ["==", 2],
  ["!=", 2],
  ["<", 3],
  [">", 3],
  ["<=", 3],
  [">=", 3],
  [".", 6],
  ["|>", 4],
  ["<|", 4],
  ["|", 6],
  ["=", 0],
  ["+=", 4],
  ["-=", 4],
  ["*=", 4],
  ["/=", 4],
  ["->", 5],
  ["=>", 5],
  [":", 0],
  ["?:", 0],
  [":=", 0],
  ["::", 6],
  [";", 4],
  ["??", 3],
  ["?.", 6],
  ["and", 0],
  ["or", 0],
  ["xor", 0],
  ["as", 0],
  ["is", 0],
  ["is_subtype_of", 0],
  ["in", 0],
  ["has_trait", 0],
]);

const isUnquotedIdentifier = (op?: unknown): op is Atom =>
  isIdentifierAtom(op) && !op.isQuoted;

export const isInfixOp = (op?: unknown): op is Atom =>
  isUnquotedIdentifier(op) && infixOps.has(op.value);

export const prefixOps: OpMap = new Map([
  ["#", 0],
  ["&", 7],
  ["!", 7],
  ["%", 7],
  ["@", 7],
  ["~", 7],
  ["not", 7],
  ["...", 5],
]);

export const isPrefixOp = (op?: unknown): op is Atom =>
  isUnquotedIdentifier(op) && prefixOps.has(op.value);

export const greedyOps = new Set(["=>", "=", "<|", ";", "|"]);

export const isGreedyOp = (op?: unknown): op is Atom =>
  isUnquotedIdentifier(op) && greedyOps.has(op.value);

export const isContinuationOp = (op?: unknown) => isInfixOp(op);
