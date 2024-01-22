import { Expr } from "./expr.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";
import { Type } from "./types.mjs";

export class Block extends Syntax {
  readonly syntaxType = "block";
  readonly body: Expr[];
  readonly returnType: Type;

  constructor(
    opts: SyntaxOpts & {
      body: Expr[];
      returnType: Type;
    }
  ) {
    super(opts);
    this.body = opts.body;
    this.returnType = opts.returnType;
  }

  toJSON() {
    return ["block", ...this.body];
  }

  clone(parent?: Expr) {
    return new Block({
      ...this.getCloneOpts(parent),
      body: this.body,
      returnType: this.returnType,
    });
  }
}
