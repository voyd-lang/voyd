import { Expr } from "./expr.mjs";
import { isIdentifier } from "./helpers.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";
import { Type } from "./types.mjs";

export type Id = string | Identifier;

export class Identifier extends Syntax {
  readonly __type = "identifier";
  readonly isQuoted?: boolean;
  /** The actual string ID of the identifier */
  value: string;
  binding?: Expr;

  constructor(
    opts: SyntaxOpts & {
      value: string;
      bind?: Expr;
      isQuoted?: boolean;
    }
  ) {
    super(opts);
    this.isQuoted =
      opts.isQuoted ??
      (opts.from instanceof Identifier ? opts.from.isQuoted : undefined);
    this.value = opts.value;
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

  clone(parent?: Expr): Identifier {
    return new Identifier({
      parent,
      value: this.value,
      from: this,
      isQuoted: this.isQuoted,
    });
  }
}
