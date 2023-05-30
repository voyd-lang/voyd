import { Expr } from "./expr.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";

export class StringLiteral extends Syntax {
  readonly __type = "string-literal";
  value: string;

  constructor(opts: SyntaxOpts & { value: string }) {
    super(opts);
    this.value = opts.value;
  }

  clone(parent?: Expr): StringLiteral {
    return new StringLiteral({ parent, value: this.value, inherit: this });
  }
}
