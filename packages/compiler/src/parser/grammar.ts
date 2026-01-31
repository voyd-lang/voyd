import { Atom } from "./ast/atom.js";
import { isIdentifierAtom } from "./ast/predicates.js";

export const identifierIs = (op: unknown, value: string): op is Atom =>
  isIdentifierAtom(op) && op.eq(value);

export const isOp = (op?: unknown): boolean => isInfixOp(op) || isPrefixOp(op);

/** Key is the operator, value is its precedence */
export type OpMap = Map<string, number>;

const precedence = {
  assign: 0,
  add: 1,
  multiply: 2,
  compare: 3,
  pipe: 4,
  arrow: 5,
  bitOr: 6,
  prefix: 7,
  access: 8,
  namespace: 9,
} as const;

export const infixOps: OpMap = new Map([
  ["+", precedence.add],
  ["-", precedence.add],
  ["*", precedence.multiply],
  ["/", precedence.multiply],
  ["^", precedence.compare],
  ["%", precedence.multiply],
  ["==", precedence.multiply],
  ["!=", precedence.multiply],
  ["<", precedence.compare],
  [">", precedence.compare],
  ["<=", precedence.compare],
  [">=", precedence.compare],
  [".", precedence.access],
  ["|>", precedence.pipe],
  ["<|", precedence.pipe],
  ["|", precedence.bitOr],
  ["&", precedence.bitOr],
  ["=", precedence.assign],
  ["+=", precedence.pipe],
  ["-=", precedence.pipe],
  ["*=", precedence.pipe],
  ["/=", precedence.pipe],
  ["->", precedence.arrow],
  ["=>", precedence.arrow],
  [":", precedence.assign],
  ["?:", precedence.assign],
  [":=", precedence.assign],
  ["::", precedence.namespace],
  [";", precedence.pipe],
  ["??", precedence.compare],
  ["?.", precedence.access],
  ["and", precedence.assign],
  ["or", precedence.assign],
  ["xor", precedence.assign],
  ["as", precedence.assign],
  ["is", precedence.assign],
  ["is_subtype_of", precedence.assign],
  ["in", precedence.assign],
  ["has_trait", precedence.assign],
]);

const isUnquotedIdentifier = (op?: unknown): op is Atom =>
  isIdentifierAtom(op) && !op.isQuoted;

export const isInfixOp = (op?: unknown): op is Atom =>
  isUnquotedIdentifier(op) && infixOps.has(op.value);

export const prefixOps: OpMap = new Map([
  ["#", precedence.assign],
  ["!", precedence.prefix],
  ["%", precedence.prefix],
  ["@", precedence.prefix],
  ["~", precedence.prefix],
  ["not", precedence.prefix],
  ["...", precedence.arrow],
]);

export const isPrefixOp = (op?: unknown): op is Atom =>
  isUnquotedIdentifier(op) && prefixOps.has(op.value);

export const greedyOps = new Set(["=>", "=", "<|", ";", "|"]);

export const isGreedyOp = (op?: unknown): op is Atom =>
  isUnquotedIdentifier(op) && greedyOps.has(op.value);

export const isContinuationOp = (op?: unknown) => isInfixOp(op);
