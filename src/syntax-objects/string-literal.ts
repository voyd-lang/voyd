import { Expr } from "./expr.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";

export class StringLiteral extends Syntax {
  readonly syntaxType = "string-literal";
  value: string;

  constructor(opts: SyntaxMetadata & { value: string }) {
    super(opts);
    this.value = opts.value;
  }

  clone(parent?: Expr): StringLiteral {
    return new StringLiteral({
      ...super.getCloneOpts(parent),
      value: this.value,
    });
  }

  toJSON() {
    return ["string", this.value];
  }
}
