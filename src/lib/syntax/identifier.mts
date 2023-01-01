import { Expr } from "./expr.mjs";
import { isIdentifier } from "./helpers.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";
import { Type } from "./types.mjs";

export type Id = Identifier | string;

export class Identifier extends Syntax {
  /** The actual string ID of the identifier */
  value: string;
  binding?: Expr;

  constructor(
    opts: SyntaxOpts & {
      value: string;
      bind?: Expr;
    }
  ) {
    super(opts);
    this.value = toIdentifier(opts.value);
  }

  get isDefined() {
    return !!this.getVar(this);
  }

  static from(str: string) {
    return new Identifier({ value: str });
  }

  getTypeOf(): Type | undefined {
    return (
      this.type ??
      (isIdentifier(this.binding) ? this.binding.getTypeOf() : undefined)
    );
  }

  setTypeOf(type: Type) {
    this.type = type;
    return this;
  }

  /** Returns the result of the identifier */
  getResult(): Expr | undefined {
    return this.getVar(this)?.value;
  }

  /** Like get result but throws if undefined */
  assertedResult(): Expr {
    const val = this.getVar(this)?.value;
    if (!val) {
      throw new Error(`Identifier ${this.value} is not defined`);
    }
    return val;
  }
}

const toIdentifier = (str: string): string => {
  return str.replace(/\'/g, "");
};

export const getIdStr = (id: Id) => (typeof id === "string" ? id : id.value);
