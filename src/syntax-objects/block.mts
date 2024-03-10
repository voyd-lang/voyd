import { Expr } from "./expr.mjs";
import { List } from "./list.mjs";
import { ScopedSyntax, ScopedSyntaxMetadata } from "./scoped-entity.mjs";
import { Type } from "./types.mjs";

export class Block extends ScopedSyntax {
  readonly syntaxType = "block";
  readonly body: List;
  returnType?: Type;

  constructor(
    opts: ScopedSyntaxMetadata & {
      body: List;
      returnType?: Type;
    }
  ) {
    super(opts);
    this.body = opts.body;
    this.body.parent = this;
    this.returnType = opts.returnType;
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
