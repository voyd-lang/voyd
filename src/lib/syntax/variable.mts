import { Expr } from "./expr.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";
import { Type } from "./types.mjs";

export class Variable extends NamedEntity {
  readonly isMutable: boolean;
  protected type?: Type;
  readonly syntaxType = "variable";
  readonly initializer?: Expr;

  constructor(
    opts: NamedEntityOpts & {
      isMutable: boolean;
      initializer?: Expr;
      type?: Type;
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

  getType(): Type {
    if (this.type) return this.type;
    throw new Error(`Type not yet resolved for variable ${this.name}`);
  }

  setType(type: Type) {
    this.type = type;
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
      location: this.location,
      inherit: this,
      parent: parent ?? this.parent,
      name: this.name,
      isMutable: this.isMutable,
      initializer: this.initializer,
      type: this.type,
    });
  }
}
