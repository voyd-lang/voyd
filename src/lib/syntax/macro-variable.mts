import { Expr } from "./expr.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";

export class MacroVariable extends NamedEntity {
  readonly isMutable: boolean;
  readonly syntaxType = "macro-variable";
  value?: Expr;

  constructor(
    opts: NamedEntityOpts & {
      isMutable: boolean;
      value?: Expr;
    }
  ) {
    super(opts);
    this.isMutable = opts.isMutable;
    this.value = opts.value;
  }

  toString() {
    return this.name.toString();
  }

  toJSON() {
    return [
      "define-macro-variable",
      this.name,
      ["reserved-for-type"],
      ["is-mutable", this.isMutable],
    ];
  }

  clone(parent?: Expr | undefined): MacroVariable {
    return new MacroVariable({
      location: this.location,
      inherit: this,
      parent: parent ?? this.parent,
      name: this.name,
      isMutable: this.isMutable,
      value: this.value,
    });
  }
}
