import { Expr } from "./expr.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";
import { Type } from "./types.mjs";

export class Variable extends NamedEntity {
  readonly isMutable: boolean;
  readonly type: Type;
  readonly syntaxType = "variable";
  readonly initializer: Expr;

  constructor(
    opts: NamedEntityOpts & {
      isMutable: boolean;
      initializer: Expr;
      type: Type;
    }
  ) {
    super(opts);
    this.isMutable = opts.isMutable;
    this.type = opts.type;
    this.initializer = opts.initializer;
  }

  getIndex(): number {
    const index = this.parentFn?.getIndexOfVariable(this) ?? -1;
    if (index < -1) {
      throw new Error(`Variable ${this} is not registered with a function`);
    }
    return index;
  }

  toString() {
    return this.name.toString();
  }

  toJSON() {
    return [
      "define-variable",
      this.name,
      this.type,
      ["is-mutable", this.isMutable],
      this.initializer,
    ];
  }

  clone(parent?: Expr | undefined): Variable {
    return new Variable({
      ...super.getCloneOpts(parent),
      isMutable: this.isMutable,
      initializer: this.initializer,
      type: this.type,
    });
  }
}
