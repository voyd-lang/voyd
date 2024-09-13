import { Expr } from "./expr.js";
import { ChildList } from "./lib/child-list.js";
import { List } from "./list.js";
import { ScopedSyntax, ScopedSyntaxMetadata } from "./scoped-entity.js";
import { Type } from "./types.js";

export class Block extends ScopedSyntax {
  readonly syntaxType = "block";
  #body = new ChildList(undefined, this);
  type?: Type;

  constructor(
    opts: ScopedSyntaxMetadata & {
      body: List | Expr[];
      type?: Type;
    }
  ) {
    super(opts);
    const { body, type } = opts;
    this.#body.push(...(body instanceof Array ? body : body.toArray()));
    this.type = type;
  }

  get children() {
    return this.#body.toArray();
  }

  get body() {
    return this.#body.toArray();
  }

  set body(body: Expr[]) {
    this.#body = new ChildList(body, this);
  }

  lastExpr() {
    return this.body.at(-1);
  }

  each(fn: (expr: Expr, index: number, array: Expr[]) => Expr) {
    this.body.forEach(fn);
    return this;
  }

  /** Sets the parent on each element immediately before the mapping of the next */
  applyMap(fn: (expr: Expr, index: number, array: Expr[]) => Expr) {
    this.#body.applyMap(fn);
    return this;
  }

  /**  Calls the evaluator function on the block's body and returns the result of the last evaluation. */
  evaluate(evaluator: (expr: Expr) => Expr): Expr | undefined {
    return this.body.map(evaluator).at(-1);
  }

  toJSON() {
    return ["block", ...this.body];
  }

  clone(parent?: Expr) {
    return new Block({
      ...this.getCloneOpts(parent),
      body: this.#body.toClonedArray(),
    });
  }
}
