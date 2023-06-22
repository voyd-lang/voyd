import { Expr } from "./expr.mjs";
import { Identifier } from "./identifier.mjs";
import { NamedEntity, NamedEntityOpts } from "./named-entity.mjs";
import { Type } from "./types.mjs";

export class Parameter extends NamedEntity {
  /** External label the parameter must be called with e.g. myFunc(label: value) */
  readonly label?: Identifier;
  readonly isMutable: boolean;
  protected type?: Type;
  readonly syntaxType = "parameter";
  readonly initializer?: Expr;

  constructor(
    opts: NamedEntityOpts & {
      label?: Identifier;
      isMutable: boolean;
      initializer?: Expr;
      type?: Type;
    }
  ) {
    super(opts);
    this.label = opts.label;
    this.isMutable = opts.isMutable;
    this.type = opts.type;
    this.initializer = opts.initializer;
  }

  getIndex(): number {
    const index = this.parentFn?.getIndexOfParameter(this) ?? -1;
    if (index < -1) {
      throw new Error(`Parameter ${this} is not registered with a function`);
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

  clone(parent?: Expr | undefined): Parameter {
    return new Parameter({
      location: this.location,
      inherit: this,
      parent: parent ?? this.parent,
      name: this.name,
      isMutable: this.isMutable,
      initializer: this.initializer,
      type: this.type,
      label: this.label,
    });
  }

  toJSON() {
    return [
      "define-parameter",
      this.name,
      ["label", this.label],
      this.type,
      ["is-mutable", this.isMutable],
      this.initializer,
    ];
  }
}
