import { Expr } from "./expr.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";

export class Nop extends Syntax {
  readonly syntaxType = "nop";

  constructor(opts: SyntaxMetadata) {
    super(opts);
  }

  clone(parent?: Expr): Nop {
    return this;
  }

  toJSON() {
    return "nop";
  }
}
