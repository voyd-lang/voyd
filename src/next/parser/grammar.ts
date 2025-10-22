import { Atom, IdentifierAtom } from "./ast/atom.js";
import { is, Syntax } from "./ast/syntax.js";

export const isIdentifier = (op?: unknown): op is IdentifierAtom =>
  is(op, IdentifierAtom);

export const identifierIs = (
  op: unknown | undefined,
  value: string
): op is Atom => isIdentifier(op) && op.value === value;

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
  ["|", 4],
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
  isIdentifier(op) && !op.isQuoted;

export const isInfixOp = (op?: unknown): op is Atom =>
  isUnquotedIdentifier(op) && infixOps.has(op.value);

export const prefixOps: OpMap = new Map([
  ["#", 0],
  ["&", 7],
  ["!", 7],
  ["%", 7],
  ["$", 7],
  ["@", 7],
  ["$@", 7],
  ["...", 5],
]);

export const isPrefixOp = (op?: unknown): op is Atom =>
  isUnquotedIdentifier(op) && prefixOps.has(op.value);

export const greedyOps = new Set(["=>", "=", "<|", ";", "|"]);

export const isGreedyOp = (op?: unknown): op is Atom =>
  isUnquotedIdentifier(op) && greedyOps.has(op.value);

export const isContinuationOp = (op?: unknown) => isInfixOp(op);
