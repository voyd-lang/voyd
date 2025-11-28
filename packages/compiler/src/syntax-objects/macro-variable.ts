import { Expr } from "./expr.js";
import { NamedEntity, NamedEntityOpts } from "./named-entity.js";

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
      ...super.getCloneOpts(parent),
      location: this.location,
      isMutable: this.isMutable,
      value: this.value?.clone(),
    });
  }
}
