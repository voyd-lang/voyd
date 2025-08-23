import { Block } from "./block.js";
import { Call } from "./call.js";
import { Expr } from "./expr.js";
import { Identifier } from "./identifier.js";
import { LexicalContext } from "./lib/lexical-context.js";
import { ScopedSyntax } from "./scoped-entity.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";
import { VoydRefType, Type } from "./types.js";
import { Variable } from "./variable.js";

export type MatchCase = {
  /** The type to match the base type against */
  matchType?: VoydRefType;
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

export class Match extends Syntax implements ScopedSyntax {
  readonly syntaxType = "match";
  lexicon = new LexicalContext();
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
    this.operand.parent = this;
    this.cases = opts.cases.map((c) => {
      if (c.matchTypeExpr) {
        c.matchTypeExpr.parent = this;
      }
      c.expr.parent = this;
      return c;
    });

    this.defaultCase = opts.defaultCase;
    if (this.defaultCase) {
      this.defaultCase.expr.parent = this;
    }

    this.type = opts.type;
    this.baseType = opts.baseType;
    this.bindIdentifier = opts.bindIdentifier;
    this.bindIdentifier.parent = this;

    if (opts.bindVariable) {
      opts.bindVariable.parent = this;
      this.registerEntity(opts.bindVariable);
      this.bindVariable = opts.bindVariable;
    }
  }

  toJSON(): object {
    return ["match", this.operand.toJSON(), ...this.cases, this.defaultCase];
  }

  clone(parent?: Expr): Match {
    return new Match({
      ...this.getCloneOpts(parent),
      operand: this.operand.clone(),
      cases: this.cases.map((c) => ({
        expr: c.expr.clone(),
        matchTypeExpr: c.matchTypeExpr?.clone(),
        matchType: undefined,
      })),
      defaultCase: this.defaultCase
        ? {
            expr: this.defaultCase.expr.clone(),
            matchTypeExpr: this.defaultCase.matchTypeExpr?.clone(),
            matchType: undefined,
          }
        : undefined,
      type: this.type,
      bindVariable: this.bindVariable?.clone(),
      bindIdentifier: this.bindIdentifier.clone(),
    });
  }
}
