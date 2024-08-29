import { Expr } from "./expr.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";

export class Bool extends Syntax {
  readonly syntaxType = "bool";
  value: boolean;

  constructor(opts: SyntaxMetadata & { value: boolean }) {
    super(opts);
    this.value = opts.value;
  }

  clone(parent?: Expr): Bool {
    return new Bool({ ...super.getCloneOpts(parent), value: this.value });
  }

  toJSON() {
    return this.value;
  }
}
