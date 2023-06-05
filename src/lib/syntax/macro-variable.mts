import { Expr } from "./expr.mjs";
import { Identifier } from "./identifier.mjs";
import { Syntax, SyntaxOpts } from "./syntax.mjs";
import { Type } from "./types.mjs";

export class MacroVariable extends Syntax {
  readonly identifier: Identifier;
  readonly isMutable: boolean;
  readonly syntaxType = "macro-variable";
  readonly initializer?: Expr;

  constructor(
    opts: SyntaxOpts & {
      identifier: Identifier;
      isMutable: boolean;
      initializer?: Expr;
      type?: Type;
    }
  ) {
    super(opts);
    this.identifier = opts.identifier;
    this.isMutable = opts.isMutable;
    this.initializer = opts.initializer;
  }

  toString() {
    return this.identifier.toString();
  }

  toJSON() {
    return [
      "define-macro-variable",
      this.identifier,
      ["reserved-for-type"],
      ["is-mutable", this.isMutable],
      this.initializer,
    ];
  }

  clone(parent?: Expr | undefined): MacroVariable {
    return new MacroVariable({
      location: this.location,
      inherit: this,
      parent: parent ?? this.parent,
      identifier: this.identifier,
      isMutable: this.isMutable,
      initializer: this.initializer,
    });
  }
}
