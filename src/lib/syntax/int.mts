import { Expr } from "./expr.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";

export class Int extends Syntax {
  readonly syntaxType = "int";
  value: number;

  constructor(opts: SyntaxOpts & { value: number }) {
    super(opts);
    this.value = opts.value;
  }

  clone(parent?: Expr): Int {
    return new Int({ parent, value: this.value, inherit: this });
  }
}
