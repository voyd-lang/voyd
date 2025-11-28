import { Expr } from "./expr.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";

export type FloatOpts = SyntaxMetadata & {
  value: FloatValue;
};

export type FloatValue = number | { type: "f64"; value: number };

export class Float extends Syntax {
  readonly syntaxType = "float";
  value: FloatValue;

  constructor(opts: FloatOpts) {
    super(opts);
    this.value = opts.value;
  }

  clone(parent?: Expr): Float {
    return new Float({
      ...super.getCloneOpts(parent),
      value: this.value,
    });
  }

  toJSON() {
    return this.value;
  }
}
