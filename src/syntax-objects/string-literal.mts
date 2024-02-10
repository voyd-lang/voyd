import { Expr } from "./expr.mjs";
import { Syntax, SyntaxMetadata } from "./syntax.mjs";

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
