import { Block } from "./block.js";
import { Call } from "./call.js";
import { Expr } from "./expr.js";
import { Identifier } from "./identifier.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";
import { ObjectType, Type } from "./types.js";
import { Variable } from "./variable.js";

export type MatchCase = {
  /** The type to match the base type against */
  matchType?: ObjectType;
  matchTypeExpr?: Expr;
  expr: Block | Call;
};

export type MatchOpts = SyntaxMetadata & {
  operand: Expr;
  cases: MatchCase[];
  defaultCase?: MatchCase;
  type?: Type;
  baseType?: Type;
  bindVariable?: Variable;
  bindIdentifier: Identifier;
};

export class Match extends Syntax {
  readonly syntaxType = "match";
  /** Match expr return type */
  type?: Type;
  /** Type being matched against */
  baseType?: Type;
  operand: Expr;
  /** A variable to bind the operand to when needed */
  bindVariable?: Variable;
  cases: MatchCase[];
  defaultCase?: MatchCase;
  bindIdentifier: Identifier;

  constructor(opts: MatchOpts) {
    super(opts);
    this.operand = opts.operand;
    this.cases = opts.cases;
    this.defaultCase = opts.defaultCase;
    this.type = opts.type;
    this.bindVariable = opts.bindVariable;
    this.baseType = opts.baseType;
    this.bindIdentifier = opts.bindIdentifier;
  }

  toJSON(): object {
    return ["match", this.operand.toJSON(), ...this.cases, this.defaultCase];
  }

  clone(parent?: Expr): Match {
    return new Match({
      ...this.getCloneOpts(parent),
      operand: this.operand.clone(),
      cases: this.cases.map((c) => ({ ...c, expr: c.expr.clone() })),
      defaultCase: this.defaultCase
        ? {
            ...this.defaultCase,
            expr: this.defaultCase.expr.clone(),
          }
        : undefined,
      type: this.type,
      bindVariable: this.bindVariable?.clone(),
      bindIdentifier: this.bindIdentifier.clone(),
    });
  }
}

/**
 * Notes:
 * - Matches must be exhaustive.
 * When a match type is an object. It must have a default case.
 * When it is a union, it must have a case for each type in the union.
 *
 * - Unions require special handling in the compiler. Each case must
 * bind an identifier to the "dereferenced"* value of the union.
 *
 * *Dereferenced means from the value of the union, not the union itself. The
 * value can still be a reference to an object.
 */
