import { Expr } from "./expr.mjs";
import { List } from "./list.mjs";
import { ScopedSyntax, ScopedSyntaxMetadata } from "./scoped-entity.mjs";
import { Type } from "./types.mjs";

export class Block extends ScopedSyntax {
  readonly syntaxType = "block";
  private _body!: List;
  returnType?: Type;

  constructor(
    opts: ScopedSyntaxMetadata & {
      body: List;
      returnType?: Type;
    }
  ) {
    super(opts);
    this.body = opts.body;
    this.returnType = opts.returnType;
  }

  get body() {
    return this._body;
  }

  set body(body: List) {
    if (body) {
      body.parent = this;
    }

    this._body = body;
  }

  lastExpr() {
    return this.body.last();
  }

  each(fn: (expr: Expr, index: number, array: Expr[]) => Expr) {
    this.body.each(fn);
    return this;
  }

  applyMap(fn: (expr: Expr, index: number, array: Expr[]) => Expr) {
    this.body = this.body.map(fn);
    return this;
  }

  /**  Calls the evaluator function on the block's body and returns the result of the last evaluation. */
  evaluate(evaluator: (expr: Expr) => Expr): Expr | undefined {
    return this.body.map(evaluator).last();
  }

  toJSON() {
    return ["block", ...this.body.toJSON()];
  }

  clone(parent?: Expr) {
    return new Block({
      ...this.getCloneOpts(parent),
      body: this.body,
      returnType: this.returnType,
    });
  }
}
