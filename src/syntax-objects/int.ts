import { Expr } from "./expr.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";

export class Int extends Syntax {
  readonly syntaxType = "int";
  value: number;

  constructor(opts: SyntaxMetadata & { value: number }) {
    super(opts);
    this.value = opts.value;
  }

  clone(parent?: Expr): Int {
    return new Int({ ...super.getCloneOpts(parent), value: this.value });
  }

  toJSON() {
    return this.value;
  }
}
