import { Expr } from "./expr.mjs";
import { MacroEntity } from "./lexical-context.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";

export type Id = string | Identifier;

export class Identifier extends Syntax {
  readonly syntaxType = "identifier";
  /** Is surrounded by single quotes, allows identifiers to have spaces */
  readonly isQuoted?: boolean;
  /** The actual string ID of the identifier */
  value: string;

  constructor(
    opts: SyntaxOpts & {
      value: string;
      isQuoted?: boolean;
    }
  ) {
    super(opts);
    this.isQuoted = opts.isQuoted;
    this.value = opts.value;
  }

  is(v: string) {
    return v === this.value;
  }

  isDefined() {
    return !!this.resolveEntity(this);
  }

  resolve() {
    return this.resolveEntity(this);
  }

  resolveAsMacroEntity(): MacroEntity | undefined {
    return this.resolveMacroEntity(this);
  }

  startsWith(search: string) {
    return this.value.startsWith(search);
  }

  replace(search: string, newVal: string): Identifier {
    return new Identifier({
      ...super.getCloneOpts(),
      value: this.value.replace(search, newVal),
    });
  }

  clone(parent?: Expr): Identifier {
    return new Identifier({
      ...super.getCloneOpts(parent),
      value: this.value,
      isQuoted: this.isQuoted,
    });
  }

  static from(str: string) {
    return new Identifier({ value: str });
  }

  toString() {
    return this.value;
  }

  toJSON() {
    return this.value;
  }
}
