import { Expr } from "./expr.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";

export class Float extends Syntax {
  readonly syntaxType = "float";
  value: number;

  constructor(opts: SyntaxMetadata & { value: number }) {
    super(opts);
    this.value = opts.value;
  }

  clone(parent?: Expr): Float {
    return new Float({ ...super.getCloneOpts(parent), value: this.value });
  }

  toJSON() {
    return this.value;
  }
}
