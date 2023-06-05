import { Expr } from "./expr.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";

export class StringLiteral extends Syntax {
  readonly syntaxType = "string-literal";
  value: string;

  constructor(opts: SyntaxOpts & { value: string }) {
    super(opts);
    this.value = opts.value;
  }

  clone(parent?: Expr): StringLiteral {
    return new StringLiteral({ parent, value: this.value, inherit: this });
  }

  toJSON() {
    return ["string", this.value];
  }
}
