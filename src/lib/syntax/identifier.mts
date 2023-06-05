import { Expr } from "./expr.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";
import { Type } from "./types.mjs";

export type Id = string | Identifier;

export class Identifier extends Syntax {
  readonly syntaxType = "identifier";
  readonly isQuoted?: boolean;
  /** The actual string ID of the identifier */
  value: string;

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
      (opts.inherit instanceof Identifier ? opts.inherit.isQuoted : undefined);
    this.value = opts.value;
  }

  get isDefined() {
    return !!this.resolveIdentifier(this);
  }

  get def() {
    return this.resolveIdentifier(this);
  }

  /** Returns the value of the identifier if assigned in expansion phase */
  getAssignedValue(): Expr | undefined {
    return this.resolveIdentifier(this)?.value;
  }

  /** Like getAssignedValue but throws if undefined */
  assertAssignedValue(): Expr {
    const val = this.resolveIdentifier(this)?.value;
    if (!val) {
      throw new Error(`Identifier ${this.value} is not defined`);
    }
    return val;
  }

  clone(parent?: Expr): Identifier {
    return new Identifier({
      parent,
      value: this.value,
      inherit: this,
      isQuoted: this.isQuoted,
    });
  }

  static from(str: string) {
    return new Identifier({ value: str });
  }

  toString() {
    return this.value;
  }
}
