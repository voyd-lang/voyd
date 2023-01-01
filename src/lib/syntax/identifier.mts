import { Expr } from "./expr.mjs";
import { isIdentifier } from "./helpers.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";
import { Type } from "./types.mjs";

export class Identifier extends Syntax {
  /** A place to store an value for the identifier during expansion time only. */
  private result?: Expr;
  /** The actual string ID of the identifier */
  value: string;
  /** The Expr the identifier is bound to. Can be a function, variable initializer, etc. */
  bind?: Expr;

  constructor(
    opts: SyntaxOpts & {
      value: string;
      bind?: Expr;
    }
  ) {
    super(opts);
    this.value = toIdentifier(opts.value);
    this.bind = opts.bind;
  }

  get isDefined() {
    return !!this.bind;
  }

  static from(str: string) {
    return new Identifier({ value: str });
  }

  getType(): Type | undefined {
    return (
      this.type ?? (isIdentifier(this.bind) ? this.bind.getType() : undefined)
    );
  }

  setType(type: Type) {
    isIdentifier(this.bind) ? this.bind.setType(type) : (this.type = type);
    return this;
  }

  /** Returns the result of the identifier */
  getResult(): Expr | undefined {
    if (this.result) return this.result;
    if (isIdentifier(this.bind)) return this.bind.getResult();
  }

  setResult(val: Expr) {
    if (isIdentifier(this.bind)) {
      this.bind.setResult(val);
      return this;
    }

    this.result = val;
    return this;
  }

  /** Like get result but throws if undefined */
  assertedResult(): Expr {
    if (this.result) return this.result;
    if (isIdentifier(this.bind)) return this.bind.assertedResult();
    throw new Error(`Identifier ${this.value} is not defined`);
  }
}

export const toIdentifier = (str: string): string => {
  return str.replace(/\'/g, "");
};
