import { Expr } from "./expr.js";
import { Syntax, SyntaxMetadata } from "./syntax.js";

export type IntOpts = SyntaxMetadata & {
  value: IntValue;
};

export type IntValue = number | { type: "i64"; value: bigint };

export class Int extends Syntax {
  readonly syntaxType = "int";
  value: IntValue;

  constructor(opts: IntOpts) {
    super(opts);
    this.value = opts.value;
  }

  clone(parent?: Expr): Int {
    return new Int({
      ...super.getCloneOpts(parent),
      value: this.value,
    });
  }

  toJSON() {
    if (typeof this.value === "number") {
      return this.value;
    }

    return this.value.value.toString() + "i64";
  }
}
