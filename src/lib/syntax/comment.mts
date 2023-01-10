import { Expr } from "./expr.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";

export class Comment extends Syntax {
  readonly __type = "comment";
  value: string;

  constructor(opts: SyntaxOpts & { value: string }) {
    super(opts);
    this.value = opts.value;
  }

  clone(parent?: Expr): Comment {
    return new Comment({ parent, value: this.value, from: this });
  }
}
